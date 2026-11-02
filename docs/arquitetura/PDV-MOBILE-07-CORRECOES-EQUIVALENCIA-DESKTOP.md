# PDV-MOBILE-07 — Correções de usabilidade e equivalência com o PDV Desktop

## 1. Diagnóstico

A auditoria comparou o Mobile com o PDV Desktop antes de alterar código.

| Falha observada | Causa raiz |
|---|---|
| Sem sessão, `/mobile/` ainda dependia só do script da página | O JWT oficial fica em `localStorage`. O navegador não envia `Authorization` ao abrir a página. Colocar `verificarToken` na rota HTML criaria um ciclo: o servidor mandaria para `/login` e o login, ao ver o token local, voltaria para `/mobile/`. A página já redireciona para `/login?next=/mobile/`. As APIs de pedido, venda e TEF continuam atrás de `verificarToken` e da licença. |
| PEDIDO e PDV apareciam mesmo com licença ausente | `mobile-inicio.js` registrava o texto da licença e deixava a navegação visível. |
| Incluir produto abria o carrinho | O clique em adicionar chamava `irPara(estado, 'carrinho')`. O botão **Ver carrinho** já existia. |
| PIX, débito, crédito e dinheiro pareciam sem ação | O clique só gravava `data-forma`. O valor ficava num campo sempre visível, sem diálogo. No celular, `autorizarEletronico` devolve `TEF_ESTACAO` e não chama `POST /api/tef/pagar`, porque o navegador não é a estação do pinpad. |
| Venda pelo Valor ausente no PDV Mobile | O Desktop usa `PdvVendaPorValor` e `POST /api/pedidos/venda-por-valor-pasteis`. O Mobile não carregava esse módulo. |

O nome no Desktop é **Venda por valor**. O botão do Mobile usa o texto pedido na sprint, **Venda pelo Valor**, e o mesmo contrato.

Classificação do diagnóstico: CONCLUÍDO.

## 2. Arquivos

Alterados:

- `frontend/mobile/index.html` — botão Sair; módulos ocultos até a licença aceitar a consulta
- `frontend/mobile/mobile-inicio.js` — sessão expirada, saída e ocultação dos módulos
- `frontend/mobile-pedido/mobile-pedido.js` — permanece em Produtos, indicador do carrinho e trava de toque repetido
- `frontend/mobile-pdv/index.html` — diálogo de valor, Venda pelo Valor e o script oficial
- `frontend/mobile-pdv/mobile-pdv.js` — diálogo, acompanhamento da estação, composição e handoff da venda por valor

Criados:

- `tests/mobile-pdv/pdv-mobile-07.test.js`
- este relatório

Não foram alterados os motores de preço, a recomposição, o MIP, a licença, o banco oficial nem o instalador. Não há adaptador Itaú. NFC-e e SEFAZ permanecem desligadas nesta tela (`emitir_fiscal: false`).

## 3. Serviços oficiais reutilizados

- Login: `/login` e `obterDestinoPosLogin` com `next` permitido em `pdv-acesso-oficial.js`
- Preço avulso: `PdvPrecoComercial` e `MotorPrecoAtacado` (sprint 03, sem fórmula nova)
- Venda por valor: `PdvVendaPorValor.validarEntrada` e `POST /api/pedidos/venda-por-valor-pasteis`
- Pagamento: `InteracaoPagamentoMisto`, `PagamentoSequencial`, `TefFluxoPagamento`, `PdvFechamentoOficial`
- TEF no celular: `GET /api/tef/acompanhamento`. A parcela entra só com aprovação e `transacao_id` ainda não vinculado
- TEF na estação com `electronAPI`: `POST /api/tef/pagar`, no processo que tem o adaptador
- Dinheiro: `POST /api/vendas/composicao-sequencial`, que chama `integrarPagamentoRecomposicao`
- Fechamento: `POST /api/vendas` com `chave_fechamento_pdv`. A repetição com venda já gravada não cria outra venda
- Tolerância: `RecomposicaoFiscalToleranciaDinheiroSimulacaoService` (20%, `nao_e_desconto`, quantidade inteira)

## 4. Diferenças Mobile × Desktop

- No Desktop com pinpad, a parcela eletrônica espera o retorno de `POST /api/tef/pagar`. No celular, o diálogo pede o valor, mostra a chave da cobrança e a parcela só entra depois da consulta da estação. O celular não carrega DLL.
- O dinheiro confirmado no diálogo segue o mesmo estado `informada` do sequencial Desktop: é a confirmação manual do operador. Ele não autoriza a composição se houver eletrônico pendente, recusado ou em processamento.
- A entrada `/mobile/` esconde PEDIDO e PDV enquanto a consulta de empresas falha por licença. O Desktop não tem essa tela.
- A emissão NFC-e continua fora desta sprint nos dois módulos mobile.

## 5. Testes

Executados com `node --test --test-concurrency=1`, um arquivo por vez.

| Arquivo | Resultado |
|---|---|
| `tests/mobile-pdv/pdv-mobile-07.test.js` | 16 passou |
| `tests/mobile-pdv/pdv-mobile-02.test.js` | 14 passou |
| `tests/mobile-pdv/pdv-mobile-03.test.js` | 13 passou |
| `tests/mobile-pdv/pdv-mobile-04.test.js` | 7 passou |
| `tests/mobile-pdv/pdv-mobile-05.test.js` | 12 passou |
| `tests/mobile-pdv/pdv-mobile-06.test.js` | 2 passou |

Os 16 casos da sprint 07 cobrem login obrigatório, sessão 401, licença ausente, saída, proteção das APIs, permanência em Produtos, Ver carrinho, venda por valor com o mesmo `validarEntrada` do Desktop (`50,00` / quantidade 4), PIX aprovado, recusa, pendência, timeout, falha de rede sem segunda cobrança, PIX + débito, PIX + dinheiro, PIX + débito + dinheiro, dinheiro isolado, composição inválida com eletrônico pendente, cobrança sem aprovação, transação repetida, celular sem autorizador, saldo pendente, fechamento integral com a mesma chave, repetição bloqueada, distribuição não autorizada, margem de 20% sem virar desconto, quantidade fracionada rejeitada pelo serviço oficial e preservação da operação de outro operador.

Bancos usados pelos testes: diretórios temporários `cds-mobpdv02` a `cds-mobpdv07` em `%TEMP%`. O banco oficial não foi aberto.

## 6. Evidência visual e licença

Servidor temporário em `127.0.0.1:3096`, banco `C:\Users\cicer\AppData\Local\Temp\cds-mobpdv07-ui\mercadao.db`. Log: `BANCO DE TESTE EM USO`. A porta 3001 não foi usada. O servidor foi encerrado e a porta 3096 ficou livre.

Abrir `/mobile/` sem sessão levou a `http://127.0.0.1:3096/login?next=/mobile/`. No viewport 390×844 a tela é o login oficial CDS Sistemas, com usuário e senha. Essa etapa está HOMOLOGADA.

A consulta de empresas nesse banco responde `LICENCA_AUSENTE`. PEDIDO, PDV, pesquisa de produto, venda por valor gravada e o diálogo de pagamento no aparelho ficam **BLOQUEADO_POR_LICENCA**. A licença oficial não foi copiada. Não houve TEF real nem transmissão à SEFAZ.

## 7. Classificação

| Item | Estado |
|---|---|
| Diagnóstico das falhas | CONCLUÍDO |
| Login oficial, sessão expirada e Sair | CONCLUÍDO e testado; o redirecionamento visual está HOMOLOGADO |
| Ocultar módulos sem licença válida | CONCLUÍDO e testado |
| Permanecer em Produtos e Ver carrinho | CONCLUÍDO e testado; visual no aparelho BLOQUEADO_POR_LICENCA |
| Venda pelo Valor no mesmo contrato | CONCLUÍDO e testado na validação; gravação no servidor BLOQUEADO_POR_LICENCA |
| Diálogo de pagamento e sequência PIX / débito / dinheiro | CONCLUÍDO e testado no contrato; operação visual BLOQUEADO_POR_LICENCA |
| Composição oficial e fechamento idempotente | CONCLUÍDO e testado |
| NFC-e, SEFAZ e Smart POS Itaú | Fora desta sprint |
| Homologação operacional com licença válida | BLOQUEADO_POR_LICENCA |

O endereço do telefone no processo da porta 3001 continua `http://192.168.0.11:3001/mobile/`.
