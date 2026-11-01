# Sprint 21D — Diagnóstico da integração entre interface e persistência

Leitura do ciclo de fechamento do PDV, da confirmação na tela até a consulta posterior. Nenhuma correção foi feita. Nenhum arquivo de produção foi alterado.

Data: 31/10/2026.

Esta sprint não executou fechamento, TEF, PIX nem emissão. Os números citados das sprints 21B, 21C e 21F vêm dos relatórios já homologados, em banco temporário. O mapa abaixo foi conferido no código atual.

## 1. Fluxo identificado

```
PDV executarFinalizacaoVenda
  → POST /api/vendas/pre-calcular-distribuicao
  → modal manual ou POST /api/tef/pagar, conforme o contrato já homologado
  → POST /api/vendas
       VendaApplicationService.criarVenda
       → OrquestradorPagamento.processarFluxoPagamentoVenda
       → executarTransacaoVendaExclusiva
            vendas, venda_recebimentos, tef_transacoes.venda_id,
            vendas_itens, venda_pagamentos, financeiro
  → resposta JSON (id, status_pagamento, valores)
  → cupom e carrinho a partir da memória da tela
  → consulta posterior: GET /api/vendas e GET /api/vendas/:id
       devolvem a venda e os itens, sem as linhas de pagamento
```

O balcão usa `POST /api/vendas`. A prestação de entrega usa `MotorFinalizacaoVenda`, outro fechamento, com a mesma reivindicação de `tef_transacoes.venda_id`.

## 2. Arquivos e funções

| Etapa | Arquivo | Função |
|---|---|---|
| Finalização | `frontend/pdv/js/pdv.js` | `executarFinalizacaoVenda`, `enviarVenda`, `finalizarPosVenda` |
| Pré-cálculo | `frontend/pdv/js/pdv.js` | `precalcularDistribuicaoFiscalVenda` |
| Manual | `frontend/pdv/js/pdv.js` | `processarVendaFiscalManual`, `abrirModalConfirmacaoFiscalManual` |
| Automático | `frontend/pdv/js/pdv.js` | `processarPagamentoTEF` |
| Empresa no header | `frontend/pdv/js/pdv.js` | `CdsEmpresaContexto.anexarHeaderXhr` |
| Rota | `backend/rotas/vendas.js` | `POST /`, `GET /`, `GET /:id`, `GET /:id/detalhes`, `GET /:id/pagamento-nao-fiscal` |
| Entrada | `backend/services/vendas/VendaApplicationService.js` | `criarVenda` |
| Pagamento | `backend/services/OrquestradorPagamento.js` | `processarFluxoPagamentoVenda`, `comprovarTransacoesTefAprovadas` |
| Gravação | `backend/services/vendas/VendaPagamentoService.js` | `criarVenda`, `executarTransacaoVendaExclusiva`, `gravarRecebimentos`, `vincularTransacoesTef`, `inserirPagamentosDaVenda` |
| Resposta | `backend/services/vendas/VendaFiscalService.js` | `responderVendaComFiscal` |
| Entrega | `backend/services/entrega/MotorFinalizacaoVenda.js` | prestação, fora do POST de balcão |
| Histórico | `frontend/pdv/js/vendas.js` | `loadVendas`, `viewVenda`, `showVendaModal` |
| Total do histórico | `frontend/shared/js/vendasHistoricoUi.js` | `obterTotalExibicaoHistoricoVenda` |
| Reimpressão | `frontend/shared/js/fiscalImpressao.js` | `reimprimirCupomNaoFiscalHistorico` |
| Schema | `backend/database.js` | `vendas`, `venda_pagamentos`, `venda_recebimentos`, `tef_transacoes` |

## 3. Mapa das tabelas

| Tabela | Papel | Ligação |
|---|---|---|
| `vendas` | Cabeçalho: `total`, `desconto`, `valor_fiscal`, `valor_nao_fiscal`, `forma_pagamento`, `status`, `status_pagamento`, `empresa_id`, `tef_transacao_id` | `empresa_id` → `empresas`. `tef_transacao_id` é o primeiro id do resultado fiscal, sem chave estrangeira para `tef_transacoes`. |
| `venda_pagamentos` | Uma linha por pagamento comercial enviado | `venda_id` → `vendas`. `tef_transacao_id` tem índice único parcial `idx_venda_pagamentos_tef_transacao_unica` quando não é nulo. Sem chave estrangeira para `tef_transacoes`. Colunas de TEF: `tef_nsu`, `tef_autorizacao`. |
| `venda_recebimentos` | Fatias fiscal, não fiscal e outros depois do orquestrador | `venda_id` → `vendas` com `ON DELETE CASCADE`. `tef_transacao_id` sem índice único e sem chave estrangeira. Colunas: `nsu`, `autorizacao`, `tipo_recebimento`. |
| `tef_transacoes` | Autorização persistida | `venda_id` preenchido só pelo `UPDATE` condicional. `empresa_id` gravado na criação. |
| `vendas_itens` | Itens | `venda_id` → `vendas`. |

Não existe coluna `acrescimo` em `vendas`. O acréscimo entra no `total` antes do `INSERT`. `desconto` é coluna própria.

## 4. Contrato de gravação e de consulta

Gravação, dentro de `BEGIN IMMEDIATE` na conexão exclusiva:

1. `INSERT` em `vendas` com totais já recalculados, `empresa_id` do contexto autorizado e `tef_transacao_id` do primeiro id.
2. `INSERT` em `venda_recebimentos` com as fatias do orquestrador.
3. `UPDATE` em `tef_transacoes` somente se `venda_id` está nulo e `empresa_id` é o da venda. Falha desfaz a transação.
4. `INSERT` em `vendas_itens` e em `venda_pagamentos`. Com id TEF, NSU e autorização saem da linha de `tef_transacoes`, não do valor divergente do cliente.
5. `COMMIT`. Erro antes disso executa `ROLLBACK`.

A resposta de sucesso traz `id`, `venda_id`, `codigo`, `status_pagamento`, `valor_fiscal`, `valor_nao_fiscal`. Não traz as linhas de `venda_pagamentos` nem de `venda_recebimentos`.

Consulta:

- `GET /api/vendas` lista o cabeçalho do dia ou da busca, filtrado pela empresa do contexto. O `SELECT` inclui `total`, `valor_fiscal`, `valor_nao_fiscal`, `desconto` e `forma_pagamento`. Não inclui `status_pagamento`, `tef_transacao_id` nem pagamentos.
- `GET /api/vendas/:id` devolve `vendas.*` e `vendas_itens`. Exige `vendas.empresa_id` igual à empresa do contexto. Não junta `venda_pagamentos`, `venda_recebimentos` nem `tef_transacoes`.
- `GET /api/vendas/:id/pagamento-nao-fiscal` lê `venda_recebimentos` do tipo `nao_fiscal` e o saldo pendente. É o caminho da segunda etapa de venda mista.

## 5. Etapas e classificação

### D1 — Interface e requisição — CONFORME

`executarFinalizacaoVenda` monta `pagamentos`, `total`, `desconto`, `acrescimo`, `valor_fiscal` e `valor_nao_fiscal`. O fiscal da tela vem de `POST /api/vendas/pre-calcular-distribuicao` quando essa chamada responde sucesso. O header `X-Empresa-Id` sai de `CdsEmpresaContexto`. `confirmacao_fiscal_manual: true` só é atribuído depois do clique no modal. O id TEF entra no pagamento no ramo automático.

A resposta usa `venda_id` e `status_pagamento`. Falha de HTTP devolve `vendaEmProcessamento` para falso e mantém o carrinho nesse retorno de erro. Sucesso chama `finalizarPosVenda`, que zera o carrinho em memória.

O cupom imediato imprime o `payload` ainda em memória, junto com o id devolvido. A tela não relê a venda depois do `COMMIT`.

### D2 — Backend — CONFORME

`POST /api/vendas` passa por contexto de empresa, modelo do PDV e caixa. `criarVenda` recalcula fiscal e não fiscal e ignora `valor_fiscal` livre do corpo. A empresa efetiva é a autorizada no backend. O orquestrador prova a transação TEF antes da gravação. A venda e o vínculo entram na mesma transação SQL. Falha de vínculo responde erro e não deixa venda quitada.

Evidência anterior, banco temporário: Sprint 21F, valor 100 contra pagamento 10 rejeitado; Sprint 21C, confirmação manual gravou fiscal 10; Sprint 21B, corpo com `valor_fiscal` 999 gravou 9,50.

### D3 — Persistência — CONFORME no cabeçalho, RISCO POTENCIAL na leitura cruzada

Cabeçalho, empresa, status de pagamento e primeiro id TEF ficam em `vendas`. O pagamento comercial fica em `venda_pagamentos`. A fatia usada pelo fiscal e pelo saldo não fiscal fica em `venda_recebimentos`.

Uma venda só fiscal de cartão gera uma linha em cada tabela de pagamento, com o mesmo valor. Uma venda mista pode gerar um pagamento comercial e duas fatias de recebimento. As colunas de NSU têm nomes diferentes: `tef_nsu` e `nsu`.

`vendas.tef_transacao_id` guarda só o primeiro id. Os demais ficam em `venda_pagamentos`. O índice único impede repetir o mesmo id nessa tabela. `venda_recebimentos.tef_transacao_id` pode repetir o id entre fatias da mesma venda. Não há chave estrangeira ligando essas colunas a `tef_transacoes`.

O acréscimo não tem coluna. Ele só permanece embutido em `vendas.total`.

### D4 — Recuperação — DIVERGÊNCIA COMPROVADA

`GET /api/vendas/:id` devolve o cabeçalho persistido, inclusive `total`, `valor_fiscal`, `valor_nao_fiscal`, `desconto`, `status`, `status_pagamento`, `forma_pagamento`, `empresa_id` e `tef_transacao_id`, mais os itens.

Não devolve `venda_pagamentos` nem `venda_recebimentos`. Forma detalhada, valor de cada meio, NSU, autorização e bandeira não saem nessa consulta. A lista `GET /api/vendas` também não seleciona `status_pagamento`.

A empresa da consulta é a do contexto, comparada com `vendas.empresa_id`. Outra empresa recebe 404.

O total exibido no histórico é `vendas.total`, sem recálculo pelos itens. `obterTotalExibicaoHistoricoVenda` lê esse campo.

### D5 — Interface depois da recuperação — DIVERGÊNCIA COMPROVADA

Logo após o sucesso, a tela usa a resposta (`venda_id`, `status_pagamento`) e o payload em memória para o cupom. Em seguida apaga o carrinho. Não há segunda leitura da venda quitada.

Ao reabrir pelo histórico (`frontend/pdv/js/vendas.js`, `showVendaModal`):

- Total, desconto e `forma_pagamento` vêm do cabeçalho persistido.
- O rótulo Status usa `vendas.status` (`concluida`), não `status_pagamento` (`quitada`).
- `valor_nao_fiscal` aparece só no aviso de cupom não fiscal, quando é maior que zero.
- Não há linha de acréscimo, nem lista de meios, nem NSU, nem autorização.
- A reimpressão não fiscal busca de novo `GET /api/vendas/:id` e monta o cupom com esse JSON, ainda sem as linhas de pagamento.

O fechamento imediato e a consulta posterior não leem a mesma fonte. O primeiro imprime a memória da requisição. O segundo mostra o cabeçalho, sem os pagamentos gravados.

## 6. Achados

| Achado | Classe |
|---|---|
| Empresa do header autorizado, totais recalculados e vínculo TEF na mesma transação SQL | CONFORME |
| Confirmação manual e fluxo automático seguem os contratos das sprints 21B, 21C, 21E e 21F | CONFORME |
| `vendas.total` recuperado é o total gravado; o histórico não recalcula pelos itens | CONFORME |
| Cupom do fechamento usa o payload em memória e não um `SELECT` posterior | RISCO POTENCIAL |
| Acréscimo visível no fechamento não tem coluna e não reaparece no histórico; o efeito fica só em `total` | DIVERGÊNCIA COMPROVADA |
| `GET /api/vendas/:id` não devolve pagamentos, recebimentos, NSU nem autorização | DIVERGÊNCIA COMPROVADA |
| Histórico rotula `vendas.status` como Status e omite `status_pagamento` | DIVERGÊNCIA COMPROVADA |
| `vendas.tef_transacao_id` guarda um id; os demais ficam só em `venda_pagamentos`, fora da consulta | RISCO POTENCIAL |
| `venda_recebimentos.tef_transacao_id` não é único; `venda_pagamentos` é | RISCO POTENCIAL |
| Comparação de produção entre as duas tabelas de pagamento no banco do cliente | NÃO VERIFICADO |

Nenhuma dessas divergências foi tratada nesta sprint.

## 7. Arquivos de uma correção futura

Se o Tech Lead autorizar uma etapa seguinte, a leitura completa passaria por:

- `backend/rotas/vendas.js` — incluir pagamentos e recebimentos em `GET /:id`, e `status_pagamento` na lista, se a tela precisar deles.
- `frontend/pdv/js/vendas.js` — mostrar os meios, o status de pagamento e os identificadores TEF a partir dessa resposta.
- `frontend/pdv/js/pdv.js` — cupom imediato, se passar a usar a venda relida em vez do payload em memória.
- `backend/database.js` — somente se for decidido persistir `acrescimo` em `vendas`. Isso seria migration e está fora deste diagnóstico.

O Motor F×NF, o orquestrador e o vínculo TEF não precisam mudar para a consulta passar a devolver o que já é gravado.

## 8. Próximo passo sugerido

Autorizar uma sprint só de leitura da venda já gravada: a consulta devolve `venda_pagamentos` e `venda_recebimentos`, e o histórico mostra esses campos. O acréscimo fica como decisão separada, porque exige coluna nova.

Não iniciar essa correção sem avaliação deste relatório.

## 9. Confirmação

Não houve alteração de produção, migration, escrita no banco oficial, fechamento real, TEF, PIX, NFC-e, NF-e nem evento à SEFAZ. Configuração e dados do cliente não foram alterados.
