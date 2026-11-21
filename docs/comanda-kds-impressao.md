# Comanda opcional após despacho KDS

O envio continua separado da impressão. A rodada e o snapshot são gravados na
mesma transação; o snapshot só fica disponível quando o despacho correspondente
é confirmado. A impressão usa exclusivamente esse snapshot e não reenvia o pedido.

Na conferência, após a confirmação efetiva do envio ao KDS, a comanda da
rodada é apresentada antes da pergunta de impressão. Escolher **Sim** solicita
a impressão; **Não** encerra a etapa sem imprimir. A prévia usa o mesmo
documento gerado para a impressora. Se a prévia não carregar, é possível
tentar novamente ou desistir; o despacho confirmado permanece inalterado.
Durante a consulta a tela informa o carregamento; após 15 segundos sem resposta,
ela permite uma nova tentativa sem reenviar o pedido. No ERP Electron, a prévia
abre em janela própria e a confirmação só fica disponível depois do carregamento.
Fechar a janela ou escolher **Não** não registra tentativa de impressão.

## Conteúdo e largura

O documento tem largura útil de 76 mm e margens de 2 mm para bobina de 80 mm.
A janela exibe o mesmo HTML usado para impressão. Configure também papel de
80 mm no driver da impressora: o adaptador usa as configurações do dispositivo.
O horário de envio exibido na prévia e na impressão converte o timestamp UTC
para `America/Fortaleza` no formato `DD/MM/YYYY HH:mm:ss`; o snapshot original
não é alterado.

Novos snapshots guardam a classificação da cozinha e os ingredientes já
registrados no item da rodada. O documento agrupa primeiro `BEBIDA`, depois
`PASTEL` e, por fim, os demais, sem reordenar o pedido. A classificação existente
reconhece tipos explícitos e insumos comercializáveis da categoria refrigerante;
outras bebidas podem não ser identificadas como `BEBIDA`.

Para itens personalizados, os componentes vêm do snapshot da venda copiado para
`cozinha_item_ingredientes`, não da ficha técnica atual. O documento diferencia
obrigatórios, opcionais selecionados e não selecionados; seleção de opcional não
comprova uma retirada. Quando não há composição confiável, ou quando um snapshot
antigo não contém classificação, o documento sinaliza essa limitação. Os snapshots
antigos não são alterados nem recebem composição retroativa.

## Implantação

Aplicar, de forma controlada e após as migrations da Cozinha e S07-3E,
`backend/migrations/s07-comanda-impressao.sql`, antes de instalar o backend
atualizado. Não executar a migration no banco oficial sem autorização e backup.
Sem a migration completa, novos despachos S07-3E são bloqueados com o código
`SCHEMA_COMANDA_INDISPONIVEL`.

Rodadas anteriores à migration não recebem snapshots retroativos. Para imprimir,
o operador precisa de acesso à empresa e vínculo ativo com a unidade da cozinha;
se houver unidade no token, ela também deve corresponder à rodada. A impressora
de cupom deve estar configurada no aplicativo Electron.

## Resultado e recuperação

O aceite pelo spooler não confirma a saída física do papel. Falhas confirmadas
permitem nova tentativa. Se a comunicação for interrompida ou o spooler não
responder, a tentativa pode permanecer em andamento: o sistema impede outra
solicitação para evitar duplicidade. Nessa situação, verificar a impressora e
encaminhar o caso ao administrador; não reenviar automaticamente.
