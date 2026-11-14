# MESAS-05.3.1 — Diagnóstico e correção do 409 na consolidação

## Resultado

O caminho reproduzível para o `409` era a repetição da seleção dos mesmos pedidos com uma nova chave de idempotência. A reserva original continuava registrada, mas o serviço só procurava uma consolidação pela chave recebida. A tentativa seguinte chegava à restrição `UNIQUE` de `venda_consolidacao_pedidos.pedido_id`; o tratamento dessa colisão devolvia:

- HTTP: `409 Conflict`
- `codigo`: `PEDIDO_EM_OUTRA_CONSOLIDACAO`
- `mensagem`: `Um dos pedidos já participa de outra consolidação.`

O cenário foi reproduzido em banco temporário: reservar com `reserva-antiga` e repetir os mesmos pedidos com `reserva-repetida`. Antes da correção, a segunda chamada falhava exatamente com esse status, código e mensagem. Não foi fornecido o corpo de uma resposta da instalação que apresentou o problema; portanto, esta evidência confirma a causa no fluxo atual e a reprodução descrita, mas não identifica o estado de uma reserva específica no banco oficial.

## Evidências auditadas

- `confirmarConsolidada` envia os IDs marcados pelo operador em `pedido_ids`; a seleção é validada novamente no servidor.
- Antes da correção, cada abertura do modal gerava um UUID novo. Repetir dentro do mesmo modal conservava a chave, mas fechar/reabrir ou recarregar podia gerar outra para os mesmos pedidos.
- O serviço reutilizava uma consolidação apenas quando encontrava a mesma `idempotency_key`. Sem essa correspondência, a associação única por pedido era a condição que convertia a reserva anterior em `PEDIDO_EM_OUTRA_CONSOLIDACAO`.
- A rota `POST /api/pedidos/venda-consolidada-mesa` responde com `codigo` e `mensagem` em erros funcionais. A interface não mostrava o `codigo`.
- Os pedidos reservados permanecem sem `venda_id` e sem faturamento até o vínculo da venda. A reserva inclui os pedidos e os itens originais; a mesa só é encerrada pelo fluxo de quitação já existente.

## Correções

- A interface persiste a chave na `sessionStorage` por empresa, mesa, atendimento e conjunto ordenado de IDs. Repetir a mesma seleção reutiliza a chave; uma seleção diferente recebe outra.
- A confirmação bloqueia clique duplicado e alterações na seleção enquanto a requisição está em andamento. Em falha de rede, mantém a chave armazenada para a tentativa seguinte.
- O erro do backend é apresentado sem substituir a mensagem; quando há código funcional, ele também é exibido. O ERP só cria o handoff e navega ao PDV depois de receber um `consolidacao_id` válido.
- O handoff preserva o `consolidacao_id`, o `venda_id` quando existente e a chave recebida. O PDV mantém a chave estável `mesa-consolidacao-<id>` para o fechamento da venda e retoma somente o vínculo quando a venda já foi persistida.
- O serviço registra chaves adicionais em `venda_consolidacao_chaves`, cada uma ligada à mesma consolidação e à assinatura exata de empresa, mesa e pedidos. Uma chave já ligada a outro conteúdo continua retornando `IDEMPOTENCIA_CONTEUDO_DIVERGENTE`.
- Uma nova chave recupera a reserva se os participantes forem exatamente os mesmos. Para uma reserva ainda pendente, o servidor revalida empresa, pedidos, mesa, atendimento aberto e operação individual antes de devolvê-la.
- Se a consolidação já tem venda persistida ou está vinculada, a recuperação devolve o mesmo identificador e impede uma segunda criação. A reivindicação de `RESERVADA` para `EM_CRIACAO` agora é atômica também quando duas chaves diferentes chegam simultaneamente.
- Reservas em `FALHA_CRIACAO` e estados `EM_CRIACAO` sem `venda_id` não são recriados automaticamente: o estado não prova se a venda oficial chegou a persistir. A reserva e os participantes ficam preservados e o servidor devolve um código funcional para verificação. Não se apagam reservas para liberar pedidos.

## Situação da recuperação

- **Reserva anterior sem venda, ainda `RESERVADA`:** recuperada quando empresa, mesa, atendimento ativo e seleção coincidem exatamente.
- **Venda persistida (`VENDA_CRIADA`) ou vinculada (`VINCULADA`):** a mesma consolidação e venda são devolvidas; o handoff permite ao PDV retomar o vínculo sem cobrar novamente.
- **Criação em andamento sem `venda_id` ou falha ambígua:** bloqueada, sem criar outra venda. Exige verificação operacional porque o serviço não consegue provar, apenas pelo estado local, que o núcleo oficial não persistiu a venda.
- **Chave reutilizada com outra seleção/mesa/empresa:** continua bloqueada.
- **Pedidos parcialmente sobrepostos com outra consolidação:** continuam bloqueados com `PEDIDO_EM_OUTRA_CONSOLIDACAO`.
- **Pedidos inelegíveis, outra empresa ou atendimento encerrado:** permanecem protegidos pelas validações existentes; a reserva pendente não contorna essas regras.

## Arquivos alterados nesta correção

- `backend/services/vendas/VendaConsolidadaMesaService.js`
- `frontend/erp/js/pedidos.js`
- `frontend/erp/js/mesas-venda-consolidada.js`
- `tests/erp/mesas-05-3-fechamento-consolidado.test.js`
- `docs/arquitetura/MESAS-05.3-FECHAMENTO-CONSOLIDADO.md`

## Validação

Execução sequencial com `node --test --test-concurrency=1`, em banco temporário:

- MESAS-05.3: 17/17.
- MESAS-05.2.2: 4/4.
- MESAS-05.2.1: 10/10.
- MESAS-05.2: 6/6.
- MESAS-05.1: 7/7.
- Total: 44/44.

Os novos casos cobrem a reserva repetida com outra chave, recuperação de venda já vinculada, divergência da mesma chave, seleção parcialmente sobreposta, falha ambígua preservada, chave estável por seleção e duas chamadas concorrentes com chaves distintas. Também passaram `node --check` nos arquivos JavaScript alterados e `git diff --check`.

Nenhum banco oficial foi acessado. Não houve venda, pagamento, TEF, NFC-e, NF-e, evento SEFAZ ou reconstrução de instalador. A homologação do fluxo visual e de pagamento real continua pendente.
