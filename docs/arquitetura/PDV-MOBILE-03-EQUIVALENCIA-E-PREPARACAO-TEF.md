# PDV-MOBILE-03 — Equivalência com o Desktop e preparação TEF

## 1. Branch e commit

- Branch: `fix/p0-lentidao-cancelamento-nfce`
- Commit analisado: `0fab77d59ff5d283e23d4fdb0b624204a5293c34`
- A sprint PDV-MOBILE-02 já estava nesse código (`frontend/mobile-pdv`, `PdvFechamentoOficial`, pagamento sequencial). Nenhuma branch foi trocada e nenhum arquivo local foi descartado.

## 2. Arquivos encontrados e alterados

Encontrados e preservados: `frontend/mobile-pdv/`, `frontend/pdv/js/pdv.js`, `pagamentoSequencial.js`, `interacaoPagamentoMisto.js`, `pdv-fechamento-oficial.js`, `frontend/shared/js/tefFluxoPagamento.js`, `backend/services/tef/TefManager.js`, `tefFactory.js`, `tefContrato.js`, `tefRepository.js`, `tefLockService.js`, `tefEvents.js`.

Alterados nesta sprint:

- `frontend/pdv/js/pdv-preco-comercial.js` — cálculo da linha com `MotorPrecoAtacado`
- `frontend/pdv/js/pdv.js` — `obterPrecoAtacado` passa a usar esse cálculo quando o script está carregado
- `frontend/pdv/index.html` e `frontend/mobile-pdv/index.html` — carregam o mesmo script
- `frontend/mobile-pdv/mobile-pdv.js` — cotação da venda avulsa, consulta da estação e bloqueio da emissão
- `backend/services/tef/tefContrato.js`, `TefManager.js`, `index.js`, `backend/rotas/tef.js` — leitura de cobrança já gravada
- `backend/services/vendas/PagamentoRecomposicaoDocumentoService.js` — exporta `centavosMoedaReal`, sem mudar a fórmula
- `tests/vendas/helpers/pdv-real-adaptador.js` — declara o handoff nulo para a função real do carrinho executar
- `tests/mobile-pdv/pdv-mobile-03.test.js`

## 3. Diferença que existia

A venda avulsa do celular usava `preco_promocional` ou `preco_venda` da consulta e gravava a linha como `UNIDADE`, sem promoção ativa, sem faixa de atacado e sem `MotorPrecoAtacado`. O Desktop monta a linha em `adicionarItemNoCarrinho`: preço de venda, promoção ativa e, se `venda_atacado` estiver ligado, a faixa mais alta atingida, sempre pelo mesmo motor.

O pagamento sequencial já era o do Desktop. O celular recusava PIX, débito e crédito sem pinpad e não consultava uma cobrança feita na estação.

## 4. Correções

A linha da venda avulsa passa por `PdvPrecoComercial.montarLinha`. A busca também chama `POST /api/produtos/identificar`. O preço confirmado no carrinho vem de `GET /api/produtos/:id`, `GET /api/produtos/:id/promocao-ativa` e `GET /api/produtos/:id/atacado`.

Os quatro cenários comparados com `adicionarItemNoCarrinho` produziram o mesmo preço unitário, subtotal, desconto e tipo de preço: varejo R$ 10 × 2 = R$ 20; promoção R$ 8 × 2 = R$ 16; atacado a partir de 5 unidades a R$ 7, quantidade 6 = R$ 42; quantidade 2 abaixo da faixa permanece no varejo.

Dinheiro continua manual. PIX, débito e crédito no celular só entram por `GET /api/tef/acompanhamento` quando a leitura devolve `aprovado` e `transacao_id`. Pendente, recusa, timeout e falha de comunicação não viram parcela recebida. A mesma transação não entra duas vezes. A soma R$ 20 permanece igual com dinheiro antes ou depois do PIX.

A emissão chama `solicitarEmissao` e retorna sem HTTP quando a distribuição não está autorizada ou quando a transmissão não está liberada. O botão da tela permanece desabilitado. O fechamento em dinheiro sem composição autorizada continua bloqueado. A segunda chamada com a venda já persistida não grava outra venda.

## 5. Contratos TEF reutilizados e lacunas

Reutilizados: `TefManager.autorizar` com `idempotency_key`, `tefLockService`, `tefRepository`, `tefEvents`, `tefContrato` (`aprovado`, `negado`, `pendente`, `cancelado`, `erro`) e os adaptadores já registrados em `tefFactory` (SiTef, PayGo, Stone, Cielo, Rede, Getnet).

Lacuna preenchida: o celular precisava ler o estado sem chamar o adaptador. `TefManager.consultar` chama o adaptador. A leitura nova é só `SELECT` por `idempotency_key` e `empresa_id`, classificada por `classificarAcompanhamento`.

Lacunas que permanecem: não há adaptador Itaú, não há protocolo, endpoint, SDK nem modelo de Smart POS identificado. `tefFactory` não recebeu provedor novo. ConnectTEF e Smart TEF não foram usados.

## 6. Como um adaptador Itaú futuro entra

O adaptador implementa o contrato já exigido por `BaseAdapter`: autorizar, cancelar, consultar, tratar recusa, cancelamento, pendência, timeout e falha. Quando a documentação oficial existir, ele é registrado em `tefFactory` como os demais. A estação autorizada inicia a cobrança pelo `POST /api/tef/pagar` já existente, com a chave de correlação. O celular só acompanha por `GET /api/tef/acompanhamento` e só então confirma a parcela no fechamento atual. O fechamento de venda não precisa ser reescrito.

## 7. Testes

`node --test --test-concurrency=1`

| Arquivo | Resultado |
| --- | --- |
| `tests/mobile-pdv/pdv-mobile-03.test.js` | 13 pass, 0 fail |
| `tests/mobile-pdv/pdv-mobile-02.test.js` | 14 pass, 0 fail |
| `tests/pdv/sprint-25-interacao-sequencial.test.js` | 4 pass, 0 fail |
| `tests/vendas/sprint-2-6-atualizar-quantidade-atacado.test.js` | 9 pass, 0 fail |
| `tests/vendas/sprint-2-7-recalculo-preco-quantidade.test.js` | 16 pass, 0 fail |
| `tests/vendas/pedido-pdv-composicao.test.js` | 19 pass, 0 fail |

Banco usado: diretório temporário `cds-mobpdv03-*` / `cds-mobpdv02-*`. O banco oficial não foi aberto.

## 8. Falhas preexistentes

Nenhuma regressão nova apareceu nos arquivos acima. Continuam fora desta sprint, e não foram alteradas: baixa de estoque 200 em vez de 197 na entrada central, `UNIDADE_ESTOQUE_INVALIDA` em mesa, coluna duplicada `utiliza_ficha_tecnica` na migração, e a asserção antiga de `nome_comercial` em `frontend/erp/js/produtos.js`.

## 9. Limitações da Smart POS

A integração com a maquininha está bloqueada até a identificação do modelo, a documentação oficial, o adaptador e a homologação específica. Esta sprint não declara compatibilidade com nenhum equipamento Itaú. Etiqueta de balança e venda por unidade convertida continuam no fluxo do Desktop; a comparação cobriu a linha comum de varejo, promoção e atacado. A tela do celular não foi percorrida no navegador nesta execução.

## 10. Nenhuma operação real

Não houve chamada a adquirente, pinpad, Smart POS ou SEFAZ. A transação `corr-pdv-03` foi inserida no banco temporário pelo teste e apenas lida. `executou_cobranca` permaneceu falso. `solicitarEmissao` não enviou HTTP. `autorizarEletronico` continua sem chamar `/api/tef/pagar` quando o celular não é a estação.

## Classificação

| Etapa | Estado |
| --- | --- |
| Preço da venda avulsa nos cenários comparados | CONCLUÍDA, TESTADA |
| Pagamento sequencial no mesmo núcleo | CONCLUÍDA, TESTADA |
| Leitura da cobrança da estação, sem executá-la | CONCLUÍDA, TESTADA |
| Recomposição, R$ 0,05 e quantidade inteira | TESTADA no serviço já existente |
| Emissão pelo celular | BLOQUEADA; o contrato fica recusado sem transmissão |
| Adaptador e operação na Smart POS Itaú | BLOQUEADA |
| Equivalência operacional e homologação | não declaradas |
