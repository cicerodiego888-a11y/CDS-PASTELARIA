# MESAS-05.2 — Finalização do pedido e envio à preparação

O garçom salva o pedido da mesa, confere o que o servidor gravou e só então confirma o envio à preparação. Salvar não dispara esse envio e não abre venda. O atendimento da mesa permanece aberto.

A tela não foi aberta no navegador. Não houve venda, pagamento, TEF, NFC-e nem acesso ao banco oficial.

## 1. Fluxo anterior

`salvarPedido` gravava o pedido e, na criação, perguntava se o operador queria gerar a venda no PDV. Não havia etapa de conferência nem chamada a `POST /api/pedidos/:id/preparacao/enviar`. O pedido de salão nascia `NAO_ENVIADO`, com o relógio parado.

## 2. Fluxo novo

No pedido com mesa:

1. **Salvar** persiste com `POST` ou, se o pedido já existe, com `PUT`. A preparação não é acionada e a venda do PDV não é oferecida.
2. **Finalizar lançamento** persiste o mesmo pedido e abre a conferência com mesa, número, itens, quantidades, observação e total devolvidos pelo servidor.
3. **Enviar pedido para cozinha** só roda no clique desse botão. A tela chama `POST /api/pedidos/:id/preparacao/enviar` com `Idempotency-Key`.
4. A confirmação mostra **Enviado para preparação**, o horário e a classificação da resposta. O texto deixa claro que isso é o registro do ERP, sem confirmação de cozinha, impressora ou KDS.

Pedido sem mesa continua no caminho antigo: salvar e, na criação, a pergunta da venda no PDV.

## 3. Contratos

Reutilizados, sem motor novo:

| Uso | Contrato |
|---|---|
| Persistir | `POST /api/pedidos` e `PUT /api/pedidos/:id` |
| Enviar | `POST /api/pedidos/:id/preparacao/enviar` |
| Lista da mesa | `GET /api/mesas/:id/atendimento/pedidos` |

A chave de envio é uma por pedido e é reaproveitada na nova tentativa. Dois cliques disparam uma requisição. A repetição devolve o `enviado_em` original. Resposta sem horário não vira sucesso. Falha de rede, pedido cancelado, faturado, sem atendimento ou mesa em fechamento limpam o sucesso e mantêm o pedido. Trocar de tela descarta a resposta atrasada.

Enquanto a preparação está `NAO_ENVIADO`, **Corrigir lançamento** reabre o mesmo identificador. A alteração usa o `PUT` já existente e não inicia o relógio. Depois do envio, a conferência não oferece correção. Ao reabrir o pedido, a tela consulta a lista da mesa e desliga a edição se o estado deixou de ser `NAO_ENVIADO`. Não foi criada rota de cancelamento.

O segundo pedido da mesma mesa nasce no mesmo `mesa_atendimento_id`. `aberto_em` não muda. O pedido enviado continua na consulta da mesa. A mesa não é encerrada.

## 4. Arquivos

- `frontend/erp/js/mesas-conferencia.js`
- `frontend/erp/js/pedidos.js`
- `frontend/erp/js/app.js`
- `tests/erp/mesas-05-2-envio-preparacao.test.js`
- `tests/erp/mesas-05-1-abertura-pedidos.test.js` — a trava de autoridade passou a procurar `mesa_atendimento_id:` no corpo, porque a tela agora lê o identificador devolvido pelo servidor

O estoque, a ficha, a composição, o F×NF, o MUV, a venda, o pagamento, o TEF e o fiscal não foram alterados. Os limites de 5 e 20 minutos permanecem no backend.

## 5. Testes

`node --test --test-concurrency=1`, uma suíte por vez. Banco temporário da suíte nova: `C:\Users\cicer\AppData\Local\Temp\cds-mesas052-wUzboR\mercadao.db`.

| Suíte | Resultado |
|---|---|
| `tests/erp/mesas-05-2-envio-preparacao.test.js` | 6 de 6 |
| `tests/erp/mesas-05-1-abertura-pedidos.test.js` | 6 de 6 |
| `tests/erp/mesas-05-painel.test.js` | 8 de 8 |
| `tests/pedidos/mesas-02-atendimento.test.js` | 9 de 9 |
| `tests/pedidos/mesas-03-transferencia.test.js` | 11 de 11 |
| `tests/pedidos/mesas-04-vinculo-preparacao.test.js` | 9 de 9 |

A suíte nova cobre a conferência sem envio automático, o clique explícito, o horário do servidor, a chave repetida, o duplo clique, a correção do pedido ainda não enviado, a rede, a resposta inválida, a troca de tela, cancelado, faturado, fechamento, o segundo pedido e o pedido sem mesa. Nenhuma venda foi gravada.

## 6. Classificação

- CONCLUÍDO: salvar, conferência, envio explícito e permanência do atendimento.
- TESTADO: as seis suítes acima.
- HOMOLOGADO: não. A tela não foi percorrida no navegador.
- BLOQUEADO: cozinha real, impressão e KDS. O evento continua sendo só o registro de preparação do ERP.
