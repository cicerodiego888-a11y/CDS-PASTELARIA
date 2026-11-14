# MESAS-05 — Painel de mesas no desktop

O ERP ganhou a tela Controle de Mesas na área principal. A grade, o modal e as ações usam as APIs de MESAS-02, MESAS-03 e MESAS-04. O navegador não recalcula ocupação, preparação, venda ou pagamento.

Não houve caminhada visual no ERP. Não houve venda, pagamento, TEF, NFC-e nem acesso ao banco oficial.

## 1. Arquitetura visual

A página é JavaScript do ERP, com jQuery e Bootstrap já usados no restante do sistema. Não entrou React nem Vue.

O cabeçalho é azul-marinho (`#0b1f3a`) e mostra o título, o nome da empresa da sessão e os contadores de livres, ocupadas e em fechamento. A grade usa `auto-fill` com cartão mínimo de 148px e não cria rolagem horizontal. Cada cartão traz o número com dois dígitos e o texto do estado.

| Situação | Cartão | Texto |
|---|---|---|
| LIVRE | verde | LIVRE |
| OCUPADA | vermelho | OCUPADA e permanência |
| FECHAMENTO | amarelo/laranja | FECHAMENTO |

O clique abre um modal central na mesma página. Mesa livre oferece “Abrir atendimento” e pesquisa clientes por nome, CPF ou telefone; é necessário selecionar um cliente cadastrado para vinculá-lo. Mesa ocupada mostra o nome do cliente vinculado (ou o número como fallback), operador da abertura, horário, permanência, pedidos e a transferência para outra mesa livre. Ao lançar um pedido, o nome e o identificador do cliente são preenchidos no editor “PEDIDO DA MESA”. As mesas ocupadas e em fechamento também oferecem “Ver todos os pedidos”, que abre a tela Pedidos sem abrir o editor e exibe somente os pedidos abertos vigentes da empresa, mesa e atendimento selecionados. Mesa em fechamento não permite transferência nem encerramento. O modal rola por dentro quando o conteúdo passa da altura da janela.

A permanência exibida no cartão parte de `aberto_em` e do relógio do aparelho. Ela não altera a classificação de preparação. Essa classificação e `tempo_decorrido_segundos` vêm do `GET` de pedidos. O total mostrado é o `total` já gravado no pedido. Não há soma de conta nem pagamento.

O atendimento persiste o `cliente_id`; as consultas das mesas o associam ao nome em `clientes`. O operador continua sendo apresentado pelo identificador: “Operador da abertura nº N”.

## 2. Arquivos

- `frontend/erp/js/mesas-painel.js`
- `frontend/erp/js/mesas-lancamento.js` — contexto da navegação sem intenção de abrir o editor
- `frontend/erp/js/pedidos.js` — seleção da aba “Todos” ao entrar pelo botão
- `frontend/css/mesas-painel.css`
- `frontend/erp/index.html` — item Controle de Mesas, recurso `pedidos`
- `frontend/erp/js/app.js` — página `mesas` e parada do painel ao trocar de módulo
- `frontend/shared/js/core.js` — catálogo e licença do recurso `pedidos`
- `frontend/shared/js/access-control.js` — permissão `vendas`, a mesma de Pedidos
- `tests/erp/mesas-05-painel.test.js`
- `tests/erp/mesas-05-1-abertura-pedidos.test.js`

O cadastro de mesas em Pedidos, o Mobile Pedido, o MUV, a venda, o pagamento sequencial, o estoque e a ficha técnica não foram alterados.

## 3. APIs

| Uso | Contrato |
|---|---|
| Grade e contadores | `GET /api/mesas/situacao` |
| Detalhe do atendimento | `GET /api/mesas/:id/atendimento` |
| Pedidos e preparação | `GET /api/mesas/:id/atendimento/pedidos` |
| Abrir atendimento | `POST /api/mesas/:id/atendimento` |
| Pesquisar clientes | `GET /api/clientes/buscar?termo=...` |
| Transferir | `POST /api/mesas/:id/atendimento/transferir` |

O corpo da abertura leva só o `cliente_id` selecionado na busca. Texto digitado sem selecionar não é tratado como vínculo de cliente. A transferência leva só `mesa_destino_id`. Empresa e operador saem da sessão. O cabeçalho usa `CdsEmpresaContexto.headersJson()` e `Idempotency-Key` nas ações. Itens com `empresa_id` de outra empresa são descartados antes da grade.

O painel não chama `POST /api/mesas/:id/atendimento/encerrar`.

## 4. Atualização periódica

O intervalo é de 5 segundos, num único `setTimeout` encadeado. Uma consulta em andamento faz a seguinte ser ignorada. A troca de mesa ou o fechamento do modal aumenta uma geração; a resposta antiga é descartada e não substitui o detalhe atual. Ao sair da página, `loadPage` chama `parar()` e o timer é cancelado. Com o modal fechado permanece só o ciclo da grade.

Se o foco está no cliente ou na mesa de destino, o valor digitado e a posição do cursor são preservados durante o redesenho; o cliente já selecionado não é descartado.

## 5. Concorrência

Estes códigos limpam o sucesso, mostram o aviso e recarregam a situação:

`MESA_OCUPADA`, `MESA_LIVRE`, `MESA_INATIVA`, `MESA_NAO_ENCONTRADA`, `ATENDIMENTO_EM_FECHAMENTO`, `MESA_DESTINO_IGUAL`, `CHAVE_IDEMPOTENCIA_DIVERGENTE`.

A lista de destino só inclui mesas livres e ativas da empresa, diferentes da origem. A confirmação nomeia a mesa de origem e a de destino. Depois da transferência o mesmo atendimento permanece aberto na mesa de destino.

## 6. Testes

`node --test --test-concurrency=1`, uma suíte por vez. Bancos temporários:

- `C:\Users\cicer\AppData\Local\Temp\cds-mesas02-Ims5ua\mercadao.db`
- `C:\Users\cicer\AppData\Local\Temp\cds-mesas03-KQJEym\mercadao.db`
- `C:\Users\cicer\AppData\Local\Temp\cds-mesas04-o0aGMN\mercadao.db`

| Suíte | Resultado |
|---|---|
| `tests/erp/mesas-05-painel.test.js` | 9 de 9 |
| `tests/erp/mesas-05-1-abertura-pedidos.test.js` | 7 de 7 |
| `tests/pedidos/mesas-02-atendimento.test.js` | 9 de 9 |
| `tests/pedidos/mesas-03-transferencia.test.js` | 11 de 11 |
| `tests/pedidos/mesas-04-vinculo-preparacao.test.js` | 9 de 9 |

Os testes do painel cobrem a grade da empresa, os três estados, os contadores, o modal, a abertura, a atualização da grade, o detalhe, os pedidos, as cinco classificações, o tempo do servidor, a transferência com atualização da origem e do destino, o bloqueio de destino ocupado, o conflito `MESA_OCUPADA`, o fechamento sem ação, a consulta sem sobreposição, o descarte da resposta antiga, a parada do timer, a navegação para a tela Pedidos com a aba “Todos” e o vínculo de navegação e permissão. A suíte do painel não abre banco.

## 7. Homologação visual

Não realizada. A tela não foi aberta num navegador, em nenhuma resolução. Os testes exercitam o HTML e o controlador, sem a janela do ERP.

## 8. Classificação

- CONCLUÍDO: painel desktop, modal, abertura, consulta, transferência e polling sobre os contratos existentes.
- TESTADO: as quatro suítes acima.
- HOMOLOGADO: não. Falta a validação visual e operacional na tela.
- BLOQUEADO: caminhada visual; painel do telefone; envio real à cozinha, impressão, KDS ou TV; fechamento de conta; venda com vários pedidos; pagamento, TEF e documento fiscal; reservas; nome do operador, porque o contrato só entrega o identificador. O encerramento técnico permanece fora do painel de propósito.
