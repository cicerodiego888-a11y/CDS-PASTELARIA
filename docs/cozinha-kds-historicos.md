# Históricos e tempos do KDS

O painel usa os eventos persistidos da cozinha. O schema compartilhado da
cozinha está na versão 9, que adiciona o snapshot imutável do relatório de
encerramento e as configurações capturadas na abertura do turno.

## Acesso na TV pela rede local

Com o CDS executando como servidor local, o acesso exclusivo para a cozinha
fica em `http://IP_DO_SERVIDOR:3002/cozinha`. O endereço não é fixo: o servidor
registra os IPv4 privados detectados e suas interfaces na inicialização; no
Windows, `ipconfig` também mostra o IPv4 do adaptador Wi-Fi. A porta pode ser
definida antes de iniciar o CDS pela variável `CDS_KDS_LAN_PORT` (1 a 65535).
Se ela já estiver ocupada, o erro aparece no log e o ERP continua funcionando.

Para uma rede com DNS local já configurado no roteador, é possível definir
`CDS_KDS_LAN_HOST` antes de iniciar o CDS com o nome exato do servidor, por
exemplo `cds-loja.home.arpa`. O endereço passa a ser
`http://cds-loja.home.arpa:3002/cozinha`. O gateway aceita somente esse nome
configurado, além dos endereços já aceitos; ele não configura o roteador nem
confirma que o nome resolve para o servidor. Configure e teste a atualização
do registro DNS no roteador quando o IP mudar. Se o nome for inválido, o
acesso KDS pela rede não é iniciado e o erro é registrado. O acesso por IP
continua disponível como contingência quando a configuração é válida.

### Anúncio na rede local

O CDS anuncia `_cds-kds._tcp.local` por mDNS/DNS-SD somente enquanto o gateway
está escutando, há IPv4 privado, o recurso de pedidos e o schema da cozinha estão
operacionais e a licença está válida. A disponibilidade é reavaliada a cada
10 segundos; mudanças de endereço recriam o anúncio. O anúncio divulga somente
identificador aleatório, versão do protocolo, caminho `/cozinha`, protocolo HTTP
e porta do gateway. A identidade e eventuais nomes ajustados por conflito são
mantidos em `config/cds-network-discovery.json` no diretório de dados do CDS,
fora do banco. Não copie esse arquivo entre instalações distintas.

O nome mDNS anunciado é aceito pelo gateway somente enquanto o anúncio está
ativo; `CDS_KDS_LAN_HOST` e acesso manual por IP continuam disponíveis. O
anúncio é removido no encerramento normal e quando o serviço deixa de estar
disponível; uma falha abrupta pode deixar registros temporários no cache da rede.
Para mDNS, o firewall precisa permitir UDP 5353 na rede local confiável e o
roteador deve permitir multicast entre os dispositivos, além da regra TCP do
gateway descrita abaixo. Não exponha portas na internet.

### Reconexão dos navegadores

Os navegadores da TV e das páginas mobile não consultam DNS-SD diretamente.
Abra inicialmente cada página pelo hostname local conhecido e pela respectiva
porta: `http://HOST:3002/cozinha` para o KDS e a porta do ERP para o mobile.
Use `CDS_KDS_LAN_HOST` e DNS local configurado para o gateway; alternativamente,
o hostname mDNS anunciado pode ser usado apenas onde o dispositivo resolver
`.local`. O nome e a porta devem ser obtidos e configurados manualmente na
primeira utilização. O anúncio atual não divulga a porta do ERP mobile.

Com o hostname mantido e o DNS/mDNS atualizado para o novo IPv4, o navegador
pode reconectar sem trocar de origem, sujeito ao cache DNS e ao suporte da
plataforma. Uma página aberta por IP não descobre o IP novo. Se for necessário
abrir outro endereço, a sessão e os dados locais não são transferidos entre
origens: autentique-se novamente e confira operações pendentes antes de agir.
Ao contrário de uma ponte DNS-SD, esta solução não descobre automaticamente o
servidor ou uma mudança do próprio hostname causada por conflito.

Enquanto a página estiver aberta, o indicador mostra procura, conexão,
reconexão ou indisponibilidade, usando apenas consultas GET à origem atual.
Conectado significa que a página KDS ou a rota pública de verificação do ERP
respondeu, **não** que a licença, a sessão ou a operação estejam autorizadas.
Ao reconectar, o KDS atualiza somente consultas; não são reenviadas ações ou
operações. Uma operação que falhou durante a queda pode ter resultado incerto:
confira seu estado antes de tentar novamente. No mobile, a monitoração não
reenvia nem conclui operações; atualize dados conforme o fluxo existente.
Se a página não estiver carregada, não há indicador nem reconexão em segundo
plano. O navegador também pode suspender sondas em abas em segundo plano.

Android, iOS e navegadores de Smart TV dependem do suporte de cada navegador
e rede à resolução escolhida; nenhuma dessas plataformas foi homologada aqui.
Um anúncio e seu identificador não autenticam o servidor e podem ser
falsificados. A conexão permanece HTTP e a autorização automática por
dispositivo ainda não existe.

Na TV, use um usuário já cadastrado, escolha uma empresa autorizada e selecione
uma unidade autorizada. Senha de primeiro acesso deve ser alterada no computador
antes de entrar pela TV. **Sair** limpa a sessão da TV. O botão **Tela cheia**
depende do suporte do navegador e de uma ação do operador. O painel existente
atualiza automaticamente os pedidos.

A porta 3002 aceita apenas IPv4 privado da mesma sub-rede da interface atendida,
além de localhost. Nela são disponibilizados apenas a página, recursos e rotas
necessárias ao KDS; os mecanismos existentes de autenticação, licença e
isolamento por empresa/unidade continuam aplicados. Isso não restringe a porta
original do ERP, que continua compartilhada pelos módulos existentes.

No Windows Firewall, permita entrada TCP na porta escolhida somente para a
sub-rede local ou para o IP da TV, no perfil de rede apropriado; não habilite
regra ampla de entrada. O perfil **Público** pode bloquear a conexão mesmo
quando o teste no próprio computador funciona. Altere o perfil para **Privado**
somente se a rede for confiável e conforme a política do local. Um administrador
deve também verificar as regras existentes da porta do ERP e garantir que não
haja encaminhamento de portas no roteador nem exposição por VPN ou túnel.
Esses controles externos não podem ser garantidos pela aplicação.

**HTTP não criptografa usuário, senha ou token.** Use somente uma rede confiável
e isolada, ou configure HTTPS por infraestrutura local apropriada antes de
utilizar credenciais em uma rede não confiável. Não coloque tokens no endereço.
A compatibilidade de tela cheia e interação com o controle remoto deve ser
homologada no navegador da TV.

## Tempos

O envio da rodada inicia a primeira espera. Os eventos de início, retorno,
conclusão e cancelamento delimitam cada período do item; espera e preparação
são somadas separadamente. A interface atualiza períodos abertos sem gravar
no banco. Retirada ou cancelamento encerra os tempos aplicáveis. O total da
rodada não soma períodos de itens paralelos.

## Relatório de encerramento do turno

Gerentes e Super Administradores podem consultar o histórico de turnos na
Gestão da Cozinha. O fechamento normal e o excepcional consolidam os dados e
persistem o snapshot do relatório junto com o fechamento, na mesma transação
SQLite. Um turno fechado pelo fluxo novo não é confirmado sem o registro
recuperável do relatório. A consulta valida a empresa e a unidade da sessão e
devolve sempre o snapshot original; hash SHA-256 e gatilhos do banco detectam
alteração ou exclusão retroativa.

Na atualização do schema v8 para v9, o inicializador usa a conexão e o caminho
efetivos do banco, cria um backup pela API online do SQLite e valida a cópia
com `PRAGMA integrity_check` antes de qualquer DDL. Registra o caminho, tamanho
e SHA-256 do backup no log e em `cozinha_schema_meta.schema_v9_backup`; se o
backup não puder ser criado ou validado, a migration é interrompida. O backup
online não força checkpoint nem remove WAL, SHM ou journal. A migration v8→v9
é aditiva e transacional; uma falha reverte tanto o DDL quanto a atualização da
versão. Em schema v9, o inicializador valida as estruturas sem reaplicar DDL.

O relatório inclui o tipo de fechamento, responsáveis, metas e configurações
capturadas ao abrir o turno, indicadores dos registros e ledgers existentes,
intervenções, ocorrências e pendências. No fechamento excepcional, as
pendências são identificadas como preservadas, sem criar retiradas ou
conclusões artificiais. Os controles de impressão e exportação PDF usam o
diálogo de impressão do ambiente.

Turnos encerrados antes da implantação não têm snapshot retroativo: a tela os
identifica como relatórios sem snapshot persistido. O histórico e os ledgers
operacionais não são regravados para simular um relatório de fechamento.

## Ciclo diário e histórico de pedidos retirados

O painel operacional consulta somente o turno aberto derivado no backend. O
despacho grava o `turno_id` da rodada e dos itens quando há turno aberto; sem
turno, a visão operacional retorna vazia. Fechar ou abrir um turno não exclui
pedidos, itens, eventos, entregas, cancelamentos, ajustes ou snapshots. Assim,
rodadas antigas permanecem consultáveis no histórico, mas não voltam às
colunas operacionais do turno atual.

Gerentes e Super Administradores acessam **Histórico de Pedidos Retirados**.
O endpoint `GET /api/cozinha/gerencial/historico-pedidos-retirados` deriva
empresa e operador da sessão e valida o vínculo gerencial com a unidade. A
consulta aceita data, turno, pedido, mesa, garçom, produto e categoria; a data
reúne todos os turnos do dia e o filtro turno limita a um único turno. A
retirada é comprovada pelo ledger oficial. Retiradas parciais, integrais e
pedidos cancelados com eventos de retirada são identificados pelos saldos dos
ledgers, sem contar a entrega de bebida como retirada.

Os eventos de preparo, bebidas, retiradas e cancelamentos são apresentados em
seções separadas, com operador e horário. As pendências de fechamento
excepcional vêm do snapshot persistido e seu SHA-256 é validado; snapshots
ausentes ou inconsistentes não são reconstruídos. O catálogo atual fornece o
nome da categoria quando não existe snapshot histórico dessa classificação.
Imprimir e Exportar PDF usam o diálogo de impressão do navegador/ambiente.

O acesso aos registros antigos sem comprovação no ledger foi movido para a
seção **Registros legados (sem comprovação no ledger)** dentro do histórico de
pedidos retirados. Esses registros permanecem claramente distintos dos
eventos oficiais; sua presença não comprova retirada individual.

Os timestamps permanecem armazenados em UTC. O KDS e seus históricos os exibem
no fuso `America/Fortaleza`, no formato `DD/MM/YYYY HH:mm:ss` para datas e
`HH:mm:ss` para horários. Essa conversão afeta somente a apresentação; os
cronômetros e durações continuam calculados sobre os instantes originais.

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

Pedidos comerciais com status `CANCELADO` não aparecem na fila operacional
normal. **Pedidos comerciais cancelados** os reexibe como exceções, sem ações
de preparo, entrega de bebida ou retirada. A interface orienta a confirmar a
situação física; o status comercial não cancela automaticamente itens já
enviados à cozinha. O cancelamento operacional continua sendo uma ação
explícita, sujeita à evidência e às validações existentes.
O backend também bloqueia retirada individual e liberação para venda de pedidos
cancelados. Os registros históricos não são reconciliados automaticamente.

## Paginação

O histórico de cancelados do KDS consulta `/api/cozinha/preparacao/painel`
com `paginacao=cursor`. O histórico de Pedidos Retirados usa paginação própria
por `limite` e `offset` no endpoint gerencial. O cursor legado permanece
disponível para integrações compatíveis.
Nos históricos do KDS, rodadas são ordenadas pelo horário e ID do último
evento correspondente dentro do snapshot, em ordem decrescente. Novos eventos
não deslocam páginas abertas; **Atualizar agora** inicia novos snapshots. Um
cancelamento efetuado no próprio painel também reinicia o snapshot
correspondente.
Ao abrir novamente **Histórico de cancelados**, o painel inicia um novo
snapshot desse histórico, incluindo cancelamentos feitos em outros terminais.
Enquanto o histórico permanece aberto, use **Atualizar agora** para incluir
novos eventos sem comprometer a estabilidade da paginação em andamento.

Para consulta individual pela API compatível, envie `historico=retirados` ou
`historico=cancelados`, `paginacao=cursor` e, para a página seguinte, `cursor`
com o valor retornado em `cursor_proximo`. `cursor_atual` permite repetir uma
página. A consulta de retirados exige perfil Gerente ou Super Administrador,
inclusive na rota compatível; ela não é incluída em `historicos=1`. O cursor é
vinculado à empresa, unidade e tipo de histórico. O contrato antigo por
`offset` permanece para clientes legados, mas não oferece estabilidade sob
inserções concorrentes.

## Registros legados sem comprovação no ledger

Dentro do histórico de pedidos retirados, a seção **Registros legados (sem
comprovação no ledger)** abre uma consulta independente dos eventos oficiais.
Ela inclui rodadas com retirada ou cancelamento sem evento correspondente e
itens cancelados sem evento próprio nem identificação expressa no evento de
cancelamento da rodada. A existência de outro evento da rodada não comprova o
cancelamento de cada item.

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

## Liberação do pedido ao PDV

A liberação verifica os registros já persistidos de `cozinha_rodadas`,
`cozinha_itens` e `cozinha_bebida_entregas`. O backend bloqueia preparação,
finalização PDV, venda vinculada e faturamento separado enquanto existir item
ativo de cozinha sem retirada confirmada. Item integralmente cancelado não
bloqueia; rodada cancelada e linhas canceladas são excluídas.

As ações de entrega de bebida e retirada individual exibem o saldo calculado
pelo backend como somente leitura. O navegador envia apenas a chave de
idempotência; dentro da transação, o backend recalcula o saldo aplicável,
considerando quantidade exigível, cancelamentos e movimentações já registradas.
Valores de quantidade enviados por clientes antigos ou alterados no navegador
não são usados pelas rotas do KDS.

A entrega de bebida é registrada separadamente da retirada. Bebidas só podem
ser retiradas até o saldo efetivamente entregue, e a rodada só é concluída
quando todos os itens exigíveis têm comprovação no ledger individual.
Quantidades mantêm precisão de milésimos; repetição com a mesma chave devolve
o resultado da operação original, sem duplicar movimentações.

## Compatibilidade S06

A suíte S06 prepara seu banco isolado com o schema atual e verifica que a
versão gravada coincide com a versão suportada, mantendo um piso de
compatibilidade V6. Os testes dos contratos de fila, worker e driver seguem
executados com adaptadores simulados, sem habilitar impressão física.
