# MESAS-01 — Auditoria da arquitetura para Controle de Mesas

Leitura do código em 2 de novembro de 2026. Nenhum arquivo de produção foi alterado. Não houve migration, venda, TEF, NFC-e nem acesso ao banco oficial.

O Controle de Mesas ainda não existe como ocupação. Existe o cadastro da mesa e o vínculo opcional de um pedido a essa mesa. A venda continua nascendo no PDV oficial, um pedido por vez.

## 1. Arquitetura atual

A mesa é um número inteiro por empresa. A tabela `mesas` é criada por `backend/utils/mesasSchema.js`. O serviço `backend/services/pedido/MesaService.js` declara, no próprio cabeçalho, que não há ocupação, transferência, junção, divisão nem fechamento de conta. Não há exclusão: a mesa é desativada.

O pedido operacional grava `pedidos.mesa_id`. Vários pedidos podem apontar para a mesma mesa ao mesmo tempo, porque nada marca a mesa como ocupada. O número exibido vem do cadastro atual (`LEFT JOIN mesas`), não de uma cópia no pedido. Trocar o número no cadastro muda o rótulo do histórico.

O registro chamado `atendimentos` em `backend/motores/muv/atendimentoSchema.js` é a materialização multiempresa do MUV. Ele tem operação por empresa, reserva fiscal e pagamento rateado. Não representa a permanência de um cliente numa mesa e não deve ser reutilizado para isso. `VendaApplicationService.concluirVendaNoNucleoOficial` grava a venda por `VendaPagamentoService` e não chama `criarAtendimento`.

Não há estado LIVRE, OCUPADA ou FECHAMENTO. O único estado da mesa é `ativo`.

## 2. Tabelas, campos e relacionamentos

| Registro | Onde | O que guarda hoje |
|---|---|---|
| `mesas` | `mesasSchema.js` | `id`, `empresa_id`, `numero` (> 0), `ativo`, `created_at`, `updated_at`. Índice único `(empresa_id, numero)`. |
| `pedidos` | `database.js` e colunas aditivas | `cliente_id` opcional, `operador_id`, `empresa_id`, `status`, `total`, `desconto`, `venda_id`, `mesa_id`, `origem_canal`, `created_at`. |
| `pedidos_itens` | `database.js` | Produto, quantidade, preço, subtotal e snapshots de nome, preço e ingredientes. |
| `pedido_faturamento_operacoes` | `PedidoFaturamentoOperacaoRepository.js` | Uma operação PDV por pedido (`pedido_id` único), payload congelado e `venda_id`. |
| `vendas` | `database.js` | A venda do PDV. `pedido_id` é um pedido. `chave` de fechamento repetida não cria outra venda. |
| `atendimentos` e tabelas filhas | `atendimentoSchema.js` | Fluxo MUV multiempresa. Sem mesa e sem permanência de salão. |

Estados do pedido, em `backend/services/pedido/enums.js`: `ORCAMENTO`, `PEDIDO`, `ABERTO`, `EM_SEPARACAO`, `AGUARDANDO_FATURAMENTO`, `FATURADO`, `CANCELADO`. Não há estado de preparo nem coluna de envio para a cozinha. O relógio existente do pedido é `created_at`. Os alertas de 5 e 20 minutos não existem. `status_entrega` pertence à venda de entrega, não à mesa.

Cliente é opcional no pedido. Operador vem da sessão nas rotas que já exigem token. Empresa do pedido HTTP é só `req.empresaId`, resolvido pelo contexto e pelo cabeçalho `X-Empresa-Id`. Corpo, query e CNPJ não substituem essa empresa (`empresaIdDoReqPedido`).

Não há tabela de estabelecimento separada da empresa. O limite físico atual da mesa é `empresa_id`. `empresa_operacional_id` e o modo `UNICA` (`pdv_empresa_id`) escolhem a empresa do caixa. Não identificam uma sala dentro da empresa.

## 3. Rotas e serviços reutilizáveis

| Peça | Uso para mesas |
|---|---|
| `GET/POST /api/mesas` e `PUT /api/mesas/:id` | Cadastro, ativação e desativação. Montadas em `server.js` com `verificarToken` e recurso `pedidos`, e de novo na rota com contexto de empresa. |
| `MesaService.validarMesaDoPedido` | Confere mesa da empresa e recusa mesa inativa em vínculo novo. |
| `PedidoOperacionalService` | Cria e atualiza o pedido, inclusive `mesa_id`, com preço e estoque já existentes. |
| `POST /api/pedidos/:id/preparar-venda-pdv` | Congela a composição de um pedido para o PDV. |
| `POST /api/pedidos/:id/finalizar-venda-pdv` | Liga esse pedido à venda já gravada. A repetição é idempotente. |
| `POST /api/vendas` | Único gravador da venda, via `VendaApplicationService`. |
| `PagamentoSequencial` e `POST /api/vendas/composicao-sequencial` | Pagamento e recomposição do fechamento. Não devem ser copiados. |
| `CdsEmpresaContexto` | Empresa compartilhada pelo ERP, pelo PDV e pelo celular. |
| Tela de mesas em `frontend/erp/js/pedidos.js` | Lista, alta, edição de número e ativação. Não é painel de salão. |
| `<dialog>` do Mobile PDV | Padrão de modal na mesma página. O Mobile Pedido hoje envia `mesa_id: null`. |

Não há WebSocket nem SSE de salão. O que existe de atualização periódica no PDV é `setInterval` de caixa, relógio e PIX. O painel de mesas pode consultar o mesmo `GET` no PC e no celular.

## 4. Lacunas

- Ocupação, fechamento de conta e transferência não existem.
- Nada impede dois operadores de abrirem a mesma mesa.
- Nada impede dois pedidos abertos na mesma mesa sem um atendimento comum.
- A conta de vários pedidos não cabe no PDV atual: a preparação e a finalização são de um `pedido_id`, e a operação de faturamento é única por pedido.
- Não há horário de abertura do atendimento, horário de envio ao preparo, nem histórico de transferência.
- Alterar `mesas.numero` reescreve o nome visto nos pedidos antigos.
- O celular não escolhe mesa.
- O PDV do computador não mostra o salão.
- Os tempos de 5 e 20 minutos não têm de onde serem calculados.

## 5. Proposta

A mesa continua sendo o lugar físico já cadastrado. O atendimento de salão é um registro novo, com outro nome de tabela, para não colidir com o atendimento do MUV. Sugestão: `mesa_atendimentos`.

Cada atendimento guarda a empresa, a mesa, o estado (`LIVRE` não precisa de linha: mesa sem atendimento aberto está livre), `OCUPADA` ou `FECHAMENTO`, cliente opcional, operador de abertura, `aberto_em` e `fechado_em`. Os pedidos continuam em `pedidos` e passam a apontar para esse atendimento. Itens, preços e estoque permanecem no pedido operacional.

A conta exibida no painel soma os totais já gravados dos pedidos ainda não faturados. Não recalcula preço.

A transferência é uma transação: a mesa de destino precisa estar livre e ativa; o atendimento troca `mesa_id` e conserva `aberto_em` e os pedidos; a origem só fica livre quando a troca é confirmada. Uma linha de histórico guarda operador, horário, mesa de origem e mesa de destino. Se a transação falha, nada é gravado.

O envio ao preparo, quando for implementado, grava um horário no pedido. A espera começa nesse horário e termina quando o pedido é concluído na preparação. A transferência não mexe nesse horário. Antes desse horário existir, o alerta de atraso não deve usar `created_at` como se fosse o envio à cozinha.

O fechamento de conta não cria venda. Ele marca `FECHAMENTO` e entrega os pedidos abertos ao PDV oficial. A venda continua em `POST /api/vendas`. Como o contrato atual finaliza um pedido, a sprint de fechamento precisa decidir, com o código do PDV na frente, como uma venda única referencia os pedidos daquele atendimento sem um segundo motor. Enquanto isso não existir, o atendimento não deve ser dado como encerrado.

Abertura simultânea: `UPDATE` ou inserção condicional em que a mesa não tenha atendimento `OCUPADA` ou `FECHAMENTO`. Transferência e fechamento repetidos usam o estado anterior na condição do `UPDATE` e uma chave de idempotência. Empresa continua sendo a de `req.empresaId`. Não duplicar `empresa_id` no item do pedido.

PC e celular leem o mesmo `GET` do painel. O PC ocupa a tela com todas as mesas. O celular empilha as mesmas mesas. O toque abre modal na própria página, no padrão do `<dialog>` já usado no Mobile PDV. Fechar o modal volta ao painel. Não há segunda página de detalhe.

O número da mesa deixa de ser editável quando já houver atendimento ou pedido. Desativar continua no lugar de excluir. Número desativado não volta a ser cadastrado.

## 6. Arquivos prováveis nas sprints seguintes

Novos, só quando a implementação for autorizada:

- serviço de atendimento de mesa, ao lado de `MesaService`, sem absorver o MUV
- rotas do painel, da abertura, da transferência e do fechamento
- migration aditiva da tabela de atendimento, do histórico e da coluna do pedido
- página do painel no PDV e o mesmo painel no celular
- testes em banco temporário

Modificados depois:

- `MesaService.atualizar`, para não renumerar mesa com histórico
- `PedidoOperacionalService`, para exigir atendimento aberto em vez de aceitar qualquer `mesa_id`
- `frontend/erp/js/pedidos.js`, só se o cadastro permanecer ali
- `frontend/mobile-pedido/mobile-pedido.js`, que hoje força `mesa_id: null`
- o handoff do PDV, apenas na sprint em que a conta for para `POST /api/vendas`

Não entram nesta frente: `TefManager`, composição F×NF, preço, estoque, emissão fiscal e o instalador.

## 7. Sequência recomendada

1. Modelo e API do atendimento, com abertura condicional e isolamento por empresa. Sem tela.
2. Transferência transacional e histórico.
3. Horário de envio ao preparo, espera, alerta de 5 minutos e estado crítico de 20.
4. Painel do PC, com modal e leitura do mesmo `GET`.
5. Painel do celular, sem página extra.
6. Fechamento da conta pelo PDV oficial, uma venda, pedidos vinculados só depois da venda persistida.

Cada etapa espera avaliação antes da seguinte. A etapa 6 é a que pode alterar o contrato de um pedido por venda. Não deve ser misturada com o painel.

## 8. Riscos

- Dois cliques podem criar dois atendimentos se a ocupação não for uma condição atômica.
- Transferir e fechar ao mesmo tempo pode liberar a mesa errada se o estado não entrar no `UPDATE`.
- Encerrar o atendimento antes de `finalizar-venda-pdv` deixa consumo sem venda, ou venda sem conta fechada.
- Reusar `atendimentos` do MUV mistura salão com materialização fiscal multiempresa.
- Renumerar a mesa apaga a leitura histórica.
- Tratar `created_at` como início da espera dispara alerta antes do pedido ir ao preparo.
- Polling curto demais em vários celulares repete a leitura do painel. O intervalo precisa ser o mesmo dos dois dispositivos e não pode disparar venda.

## 9. Testes por etapa

Etapa 1: abrir mesa livre; segunda abertura da mesma mesa recusada; outra empresa não vê a mesa; mesa inativa recusada; cliente ausente permitido.

Etapa 2: transferir para mesa livre conserva pedidos e `aberto_em`; destino ocupado recusado; falha no meio não libera a origem; histórico com operador, hora, origem e destino.

Etapa 3: espera conta a partir do envio; conclusão do pedido zera a espera dele; transferência não zera; 5 minutos marca atraso; 20 minutos marca crítico.

Etapa 4 e 5: PC e celular recebem o mesmo JSON; modal não troca de rota; fechar o modal mantém o painel; sessão sem token não lê o painel.

Etapa 6: a venda sai de `POST /api/vendas`; repetir o fechamento não cria outra venda; pedido cancelado ou já faturado não entra na conta; atendimento em `FECHAMENTO` não recebe pedido novo; a mesa só volta a `LIVRE` depois da finalização confirmada.

Nenhuma dessas etapas foi implementada nesta auditoria.
