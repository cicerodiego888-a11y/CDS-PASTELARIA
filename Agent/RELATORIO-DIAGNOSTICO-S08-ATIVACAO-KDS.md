# S08 — Relatório de diagnóstico da ativação do KDS

## Conclusão executiva

A S08 permanece bloqueada antes de qualquer alteração de código ou de banco oficial. Foram encontradas duas divergências que impedem uma homologação confiável: a instância Electron aberta não pertence à raiz deste repositório, e o backend acessível localmente não expõe as rotas de cozinha esperadas pelo código desta raiz. O SQLite local examinado também não contém nem o schema base de cozinha nem as estruturas S07.

Nenhuma migration oficial foi executada. Nenhum arquivo de produção foi editado nesta etapa.

## Diagnóstico do runtime

- A janela observada é `CDS ERP — Retaguarda`, mas o processo Electron identificado está sob `C:\projetos\CDS-SISTEMAS - CREMOLICIA`, não sob `C:\projetos\CDS-SISTEMAS PASTELARIA` (raiz deste trabalho).
- A configuração em `C:\ProgramData\MercantilFiscal\dados\config\config-servidor.json` indica modo `local` e porta `3002`.
- `GET http://127.0.0.1:3002/api/ping` respondeu `200 {"status":"ok"}`. A porta `3001` não respondeu.
- Na porta 3002, os GETs anônimos `/api/cozinha/roteamento`, `/api/cozinha/canais` e `/api/cozinha/unidades` responderam `404`. No código desta raiz, as rotas de cozinha são montadas em `/api/cozinha` atrás de autenticação; uma chamada sem token passa pelo middleware de autenticação, não deveria provar que o schema está ausente. O 404 observado indica que o backend acessível não corresponde ao contrato de rotas desta raiz ou está servindo outra versão.
- A árvore de acessibilidade da janela expôs apenas o título e o contêiner principal; não foi possível confirmar visualmente os avisos da interface. Não havia sessão autenticada disponível para testar as rotas protegidas.

**Conclusão sobre conexão:** o usuário confirmou `C:\ProgramData\MercantilFiscal\dados` como `DB_DIR` do alvo PASTELARIA. Portanto, o arquivo examinado é o banco-alvo informado, e a ausência das estruturas descritas abaixo está confirmada nesse banco. O processo Electron aberto continua vindo de outro checkout, então o 404 observado ainda não pode ser atribuído ao backend do alvo.

## Estado do SQLite local candidato

Arquivo examinado em modo somente leitura: `C:\ProgramData\MercantilFiscal\dados\mercadao.db`.

- `PRAGMA user_version`: `0`.
- 259 tabelas no total; entre as tabelas relevantes aparecem `empresas` e `pedidos`, mas nenhuma tabela `cozinha_*`.
- Ausentes `cozinha_unidades` e `cozinha_schema_meta` (schema base S07-2).
- Ausentes `cozinha_roteamento_config` e `cozinha_roteamento_segmentos` (S07-3A).
- Ausentes `cozinha_canais` e `cozinha_canal_destinos` (S07-3C).
- Ausentes `cozinha_pedido_despachos` (S07-3E).
- `pedidos` contém `origem_canal`, mas não contém as colunas S07-3D `cozinha_canal_codigo`, `unidade_cozinha_destino_id` e `cozinha_resolucao_status`.
- A tabela `empresas` não contém registros.

Nesse arquivo, as estruturas S07-2/3A/3C/3D/3E não estão aplicadas. A aplicação de migrations continua bloqueada: embora o `DB_DIR` tenha sido confirmado, a instalação em execução não corresponde ao checkout-alvo e a tabela `empresas` está vazia.

## Causa dos avisos e da prévia

Em [cozinha-roteamento.js](../frontend/erp/js/cozinha-roteamento.js), a prévia é ativada quando as rotas retornam `503` com `SCHEMA_ROTEAMENTO_INDISPONIVEL` ou `SCHEMA_CANAIS_INDISPONIVEL`. Isso é coerente com schema ausente se o backend correto estiver conectado ao banco sem essas tabelas.

Entretanto, o backend ativo observado respondeu `404` para essas rotas. Logo, os avisos relatados não podem ser atribuídos com segurança ao backend acessível nesta sessão: podem vir de outra instância, outro checkout ou outro servidor. O 404 deve ser resolvido/alinhado antes de concluir que a causa é somente a migration.

Arquivos do contrato nesta raiz:

- [electron.js](../electron.js) — modo de inicialização e `DB_DIR`.
- [server.js](../backend/server.js) — montagem de `/api/cozinha` com autenticação.
- [cozinha.js](../backend/rotas/cozinha.js) — endpoints de roteamento e canais.
- [cozinha-roteamento.js](../frontend/erp/js/cozinha-roteamento.js) — tratamento de `503` e prévia.
- [sqliteOfficialGuard.js](../backend/lib/sqliteOfficialGuard.js) e [database.js](../backend/database.js) — validação e abertura do banco.

## Validação isolada e regressões

- As migrations S07-3A, S07-3C, S07-3D e S07-3E foram executadas somente em SQLite temporário com schema base sintético. Asserções de schema, inserts sintéticos e `foreign_key_check` passaram. Log: [LOG-S08-MIGRATIONS-ISOLADAS.txt](./LOG-S08-MIGRATIONS-ISOLADAS.txt).
- As 18 suítes S06/S07 passaram quando cada arquivo foi executado em processo separado: **314/314**, exit code 0. Foram usadas as flags `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`, `DB_DIR` temporário por suíte e `CDS_ALLOW_OFFICIAL_DB` ausente. Log integral: [LOG-S08-REGRESSOES-S06-S07-POR-SUITE.txt](./LOG-S08-REGRESSOES-S06-S07-POR-SUITE.txt).
- O teste de upgrade do schema base S04A também passou isoladamente: **15/15**, exit code 0, com as mesmas flags obrigatórias e limpeza do diretório temporário criado pelo teste. Somando as execuções isoladas, foram **329/329 testes** em 19 arquivos; o teste S04A está documentado como execução adicional no mesmo log.
- Uma execução agrupada anterior teve **313/314**, com falha no teste E-03 de [sprint06-bloco-e-electron-integracao.test.js](../tests/cozinha/sprint06-bloco-e-electron-integracao.test.js), enquanto a execução isolada desse arquivo passou. A causa da divergência entre execução agrupada e isolada não foi determinada; ela permanece registrada, sem alteração de S06. Log: [LOG-S08-REGRESSOES-S06-S07.txt](./LOG-S08-REGRESSOES-S06-S07.txt).

## Plano preliminar de migration — não autorizado/não executado

Este plano só pode ser aplicado depois de identificar o banco ativo e confirmar que o backend em execução corresponde ao checkout correto.

1. Verificar no banco real o schema base S07-2, incluindo `cozinha_unidades`, `cozinha_rodadas`, `cozinha_itens` e as chaves/índices usados pelas FKs; confirmar também a estrutura de `pedidos` e `empresas`.
2. Em manutenção, parar escritas e gerar backup consistente do arquivo SQLite identificado; validar que o backup abre e contém as tabelas/dados esperados.
3. Aplicar primeiro o schema base S07-2, se realmente ausente e após autorização. Aplicar as migrations S07-3A → S07-3C → S07-3D → S07-3E, respeitando as dependências: roteamento/canais exigem unidades; S07-3D exige canais e pedidos; S07-3E exige o destino S07-3D e rodadas/itens.
4. Validar as colunas/tabelas esperadas, índices, integridade referencial e leitura das rotas autenticadas antes de reabrir as escritas.

**Rollback:** se qualquer etapa falhar antes do commit, reverter a transação e manter o backend parado até verificar o estado. Se já houve commit, restaurar o backup somente com o sistema parado e sem gravações posteriores; caso tenham ocorrido novas gravações, interromper e preparar recuperação controlada para não perder vendas. Nenhuma dessas ações foi realizada.

## Escopo alterado e segurança

- Nenhum código de produção, migration ou arquivo S06 foi alterado nesta etapa.
- Nenhuma migration foi executada no banco oficial ou no SQLite local candidato.
- O único artefato novo desta rodada além deste relatório é o log integral das regressões por suíte.
- Alterações preexistentes no worktree foram preservadas.

## Alvo confirmado

O usuário selecionou `CDS-SISTEMAS PASTELARIA` como repositório-alvo. A janela atualmente aberta continua sendo do checkout `CDS-SISTEMAS - CREMOLICIA`; portanto, ela não pode ser usada como runtime de homologação deste repositório. O `DB_DIR` efetivo do processo correto ainda precisa ser confirmado antes de iniciar uma aplicação ou fazer qualquer alteração persistente.

## Próximos passos seguros

1. Abrir/fornecer o runtime operacional construído a partir deste checkout e identificar seu `DB_DIR` efetivo.
2. No runtime confirmado, validar as rotas protegidas com sessão autenticada obtida pelo fluxo normal da aplicação.
3. Só depois de confirmar o banco real, revisar o diagnóstico do schema e o plano de backup/rollback acima.
4. Aguardar autorização explícita antes de qualquer migration no banco oficial.

Não iniciar S09.
