# Históricos e tempos do KDS

O painel usa os eventos persistidos da cozinha. Não há migração adicional:
o schema compartilhado permanece na versão 7.

## Tempos

O envio da rodada inicia a primeira espera. Os eventos de início, retorno,
conclusão e cancelamento delimitam cada período do item; espera e preparação
são somadas separadamente. A interface atualiza períodos abertos sem gravar
no banco. Retirada ou cancelamento encerra os tempos aplicáveis. O total da
rodada não soma períodos de itens paralelos.

Quando a sequência de eventos não permite reconstruir os períodos, a interface
exibe “Histórico de tempos incompleto”. Eventos antigos de cancelamento de
rodada podem não registrar o estado anterior de cada item; nesse caso não se
infere esse estado nem se inventam durações. A ausência simultânea de eventos
que retornariam ao mesmo estado não pode ser detectada apenas pelo estado atual.

## Cancelamento operacional

Os botões de cancelamento de item e de rodada abrem um formulário do KDS,
sem depender dos diálogos `prompt` ou `confirm` do Electron. O operador escolhe
um motivo e confirma o envio; para **Outro**, a justificativa é obrigatória.
**Voltar** fecha o formulário sem enviar. O cancelamento não altera pedido
comercial nem pagamento.

## Paginação

O KDS consulta `/api/cozinha/preparacao/painel` com `paginacao=cursor`.
Cada histórico recebe seu próprio cursor, limitado ao maior ID de evento
existente quando a navegação começa. Rodadas são ordenadas pelo horário e ID
do último evento correspondente dentro desse snapshot, em ordem decrescente.
Novos eventos não deslocam páginas abertas; **Atualizar agora** inicia novos
snapshots. Uma retirada ou cancelamento efetuado no próprio painel também
reinicia o snapshot do histórico correspondente.
Ao abrir novamente **Histórico de cancelados**, o painel inicia um novo
snapshot desse histórico, incluindo cancelamentos feitos em outros terminais.
Enquanto o histórico permanece aberto, use **Atualizar agora** para incluir
novos eventos sem comprometer a estabilidade da paginação em andamento.

Para consulta individual, envie `historico=retirados` ou `historico=cancelados`,
`paginacao=cursor` e, para a página seguinte, `cursor` com o valor retornado
em `cursor_proximo`. `cursor_atual` permite repetir uma página. O cursor é
vinculado à empresa, unidade e tipo de histórico; a autorização continua a
ser feita pela sessão. Para o painel combinado, usam-se `cursor_retirados` e
`cursor_cancelados`. O contrato antigo por `offset` permanece para clientes
legados, mas não oferece estabilidade sob inserções concorrentes.

## Histórico legado

O botão **Histórico legado** abre uma consulta independente dos históricos de
retirados e cancelados. Ela inclui rodadas com retirada ou cancelamento sem
evento correspondente e itens cancelados sem evento próprio nem identificação
expressa no evento de cancelamento da rodada. A existência de outro evento da
rodada não comprova o cancelamento de cada item.

O endpoint autenticado é `GET /api/cozinha/preparacao/painel?historico=legado`.
Use `limite` e `cursor` com o valor de `cursor_proximo` para navegar. O cursor
é vinculado à empresa e unidade da sessão; a ordenação é por ID de rodada
decrescente. A primeira consulta fixa os maiores IDs de rodada e item: novas
rodadas e novos itens não deslocam as páginas abertas. **Atualizar agora**
começa uma nova consulta. Os IDs e os registros são persistidos no banco, de
modo que o cursor pode continuar após reinicialização.

O limite de IDs não congela o conteúdo das linhas nem protege contra edição ou
exclusão externa de dados e eventos já existentes. Operações normais preservam
os eventos e estados terminais; alterações externas exigem nova consulta.
O aviso `registros_sem_evento` dos históricos principais ainda conta rodadas,
não itens; consulte o histórico legado mesmo quando não houver esse aviso.

Os registros e eventos existentes não são alterados. Campos ausentes aparecem
como “Não disponível”. Tempos de item são calculados somente com sequência
completa e horários explícitos nos eventos; quando não há evidência suficiente,
aparecem como “Não reconstruível”. O total e a espera do garçom também exigem
os horários persistidos necessários. A consulta não usa `updated_at` nem
substitui o horário operacional ausente pelo horário de criação do evento.

## Compatibilidade S06

A suíte S06 prepara seu banco isolado com o schema atual e verifica que a
versão gravada coincide com a versão suportada, mantendo um piso de
compatibilidade V6. Os testes dos contratos de fila, worker e driver seguem
executados com adaptadores simulados, sem habilitar impressão física.
