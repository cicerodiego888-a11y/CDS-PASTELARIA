# S08 — Status de ativação operacional do KDS

## Resultado

**S08 não homologada em ambiente operacional.** Os testes em banco temporário confirmam os fluxos implementados, mas o runtime candidato não corresponde ao checkout deste repositório e seu banco não possui o schema de cozinha. Nenhuma migration oficial foi aplicada e nenhuma alteração funcional foi feita nesta rodada.

O diagnóstico detalhado do ambiente permanece em [RELATORIO-DIAGNOSTICO-S08-ATIVACAO-KDS.md](./RELATORIO-DIAGNOSTICO-S08-ATIVACAO-KDS.md). As alterações que já existiam no worktree foram preservadas.

## Diagnóstico e causa raiz

O diagnóstico somente leitura registrado para a instalação candidata identificou:

- O processo Electron observado vinha de `CDS-SISTEMAS - CREMOLICIA`, não deste checkout `CDS-SISTEMAS PASTELARIA`.
- O backend acessível na porta 3002 respondia `200` em `/api/ping`, mas `404` nas rotas de cozinha; portanto, não atendia ao contrato de rotas deste checkout. Não havia sessão autenticada para validar endpoints protegidos.
- O candidato `C:\ProgramData\MercantilFiscal\dados\mercadao.db` estava com `user_version=0`, sem o schema base S07-2, sem as tabelas S07-3A/3C/3E e sem as colunas S07-3D. A tabela `empresas` não possuía registros.

Assim, há dois bloqueios independentes: **backend/runtime de outro checkout** e **banco candidato sem schema/unidades/empresa para operar a cozinha**. O aviso e a prévia visual, isoladamente, não provam uma falha de reconhecimento de schema no backend correto.

Neste checkout, [backend/server.js](../backend/server.js) monta `/api/cozinha`; as APIs de roteamento e canais verificam as tabelas e devolvem `503` com códigos específicos quando ausentes, sem criar DDL. [cozinha-roteamento.js](../frontend/erp/js/cozinha-roteamento.js) exibe a prévia e mantém a gravação bloqueada nessa condição. A prévia não representa configuração persistida.

**Cuidado operacional:** [backend/database.js](../backend/database.js) chama a garantia do schema base da cozinha durante a inicialização do banco. Não iniciar este checkout apontando para o banco oficial enquanto a aplicação/alteração de schema não estiver autorizada e controlada.

## Migrations e segurança

Estado registrado no banco candidato:

- S07-2 (schema base): ausente.
- S07-3A (`cozinha_roteamento_config`, `cozinha_roteamento_segmentos`): ausente.
- S07-3C (`cozinha_canais`, `cozinha_canal_destinos`): ausente.
- S07-3D (`pedidos.cozinha_canal_codigo`, `unidade_cozinha_destino_id`, `cozinha_resolucao_status`): ausente.
- S07-3E (`cozinha_pedido_despachos` e colunas de despacho): ausente.

As migrations SQL S07-3A, S07-3C, S07-3D e S07-3E foram executadas somente em SQLite temporário, com `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`, `DB_DIR` temporário e `CDS_ALLOW_OFFICIAL_DB` ausente. Asserts de schema, FK de isolamento entre empresas, snapshot de destino, idempotência e `foreign_key_check` passaram.

Aplicação oficial continua **não autorizada/não executada**. Plano pendente: confirmar backend e banco efetivamente ativos; obter backup consistente e verificar sua leitura; aplicar schema base S07-2 se necessário e, depois, S07-3A → S07-3C → S07-3D → S07-3E; validar tabelas, colunas, índices, FKs e endpoints autenticados antes de retomar escrita. Rollback: reverter antes do commit; após commit, restaurar backup somente com sistema parado e sem gravações posteriores. Se houver gravações novas, interromper para recuperação controlada, sem restauração que descarte vendas. Exige autorização explícita antes de qualquer escrita oficial.

## Testes executados

### Regressões S06/S07

Execução isolada por arquivo, com as flags de isolamento acima:

- 18 arquivos; **314 testes**.
- Resultado da primeira rodada: **313 aprovados, 1 falha, exit code 1**.
- As 11 suítes S07 passaram: **189/189**.
- O único erro ocorreu na suíte `sprint06-bloco-e-electron-integracao.test.js`: chamada explícita de `executarTickSeguro()` coincidiu com tick já agendado, e recebeu `{skipped:true}` sem `ok`; a asserção do teste esperava `ok === false`. A repetição isolada da suíte passou **16/16**, exit code 0.
- A falha intermitente foi mantida no log; não foi alterada a fila, o worker ou qualquer código S06. A primeira rodada não teve exit code global zero.

### Integração HTTP e despacho

Na suíte S07-3E isolada, o teste `POST /api/pedidos confirma pedido, destino, despacho e leitura KDS por unidade` passou. Ele verifica persistência comercial e do destino, despacho concluído, visibilidade somente na unidade correta e ausência de job na fila de impressão S06. A suíte também cobre falha/recuperação, concorrência e idempotência. As suítes de roteamento/canais exercitam seus endpoints HTTP com banco temporário.

Isso homologa o fluxo no harness isolado, **não** a instalação Electron atualmente observada. Não foi possível confirmar os endpoints autenticados do runtime correto nem concluir o teste operacional ponta a ponta na instalação.

Logs integrais desta rodada:

- [LOG-S08-VALIDACAO-S06-S07-FINAL.txt](./LOG-S08-VALIDACAO-S06-S07-FINAL.txt) — execução das 18 suítes e repetição S06 E-03.
- [LOG-S08-MIGRATIONS-ISOLADAS-FINAL.txt](./LOG-S08-MIGRATIONS-ISOLADAS-FINAL.txt) — aplicação das quatro migrations em banco temporário.

## Arquivos e diff

- Nenhum arquivo de produção, migration ou teste S06/S07 foi editado nesta rodada.
- Este relatório e os dois logs acima são os únicos arquivos novos desta rodada.
- O worktree já continha alterações staged, unstaged e untracked preexistentes; elas foram preservadas e não são atribuídas a esta rodada.
- Logo, não há diff funcional novo a apresentar. As migrations oficiais permanecem pendentes.

## Pendências para aceite

1. Abrir o runtime produzido deste checkout e confirmar `DB_DIR`, backend, empresa e unidade autenticados.
2. Obter autorização explícita antes de qualquer aplicação de migration no banco oficial.
3. Após alinhamento do runtime/schema, homologar os endpoints autenticados e a operação na instalação real.
4. Resolver ou registrar formalmente a intermitência do teste S06 E-03 sem alterar o comportamento congelado da impressão.

S09 não foi iniciado.
