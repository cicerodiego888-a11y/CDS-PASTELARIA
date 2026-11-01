# Sprint 34 — Classificação dos pagamentos e guarda fiscal da recomposição

Correção da classificação financeira e da guarda do emissor, com testes no isolamento habitual do projeto. A homologação visual e operacional permanece com o Tech Lead. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` continua `false`. Nenhum TEF, PIX, adquirente ou documento foi enviado à SEFAZ. O banco oficial não foi aberto.

## 1. Causa técnica dos dois problemas

1. **A classificação seguia o bucket do orquestrador, e o ajuste pela forma só rodava depois da distribuição autorizada.** `OrquestradorPagamento.montarRecebimentosParaGravar` grava `tipo_recebimento` pelo saldo MIDP. Quando a distribuição não é autorizada, `criarVenda` zera o valor fiscal e manda o total comercial para o não fiscal. O MIDP então marca PIX, débito e crédito como `nao_fiscal`. O trecho que reclassificava pela forma em `VendaPagamentoService.js` estava dentro de `if (req.__distribuicaoReferenciaAplicada)` e ainda preservava um `tipo_recebimento` já gravado como `nao_fiscal`. A falta de autorização mudava a natureza do recebimento.

2. **O emissor só via separação quando os totais já estavam persistidos ou quando já existia tipo não fiscal.** `vendaExigeSeparacaoDePagamento` exigia dinheiro ou tipo não fiscal junto com eletrônico e, além disso, `valor_fiscal` e `valor_nao_fiscal` positivos ou um tipo não fiscal já gravado. Uma venda com PIX e dinheiro confirmados, mas com totais ainda zerados e sem tipo, não era reconhecida como venda mista. `resolverPagamentosNfce` tratava parcela sem tipo como fiscal, e o dinheiro podia entrar como `tPag` 01. `selecionarItensFiscaisParaNfce` já bloqueava o carrinho quando a referência das formas divergia da soma fiscal dos itens; o filtro de pagamento não tinha a mesma leitura.

## 2. Arquivos alterados

- `backend/services/vendas/PagamentoSequencialComposicaoService.js` — `classificarTipoRecebimento`, separado de `parcelaEfetivamenteConfirmada`.
- `backend/services/vendas/VendaPagamentoService.js` — a reclassificação dos recebimentos ocorre sempre, depois do orquestrador e independente de `integrarPagamentoRecomposicao` e de `authDist.ativa`.
- `backend/services/fiscal/xmlBuilder.js` — a separação passa a ser reconhecida pela forma confirmada, mesmo sem totais gravados.
- `tests/pdv/sprint-34-classificacao-pagamentos-guarda-fiscal.test.js` — cenários da sprint.
- `tests/pdv/sprint-25-fechamento-universal-misto.test.js` — o cenário C passou a esperar o bloqueio da distribuição e a classificação por forma. A lista sequencial continua gravada.

Investigados e mantidos: `PagamentoRecomposicaoDocumentoService.js`, `frontend/pdv/js/pagamentoSequencial.js`, `frontend/pdv/js/pdv.js`, `backend/services/vendas/VendaFiscalService.js` e `backend/services/fiscal/emissor.js`. O PDV já exporta dinheiro como `nao_fiscal` e eletrônico aprovado como `fiscal` antes do fechamento. O emissor já devolve `DISTRIBUICAO_NAO_AUTORIZADA` quando a soma fiscal dos itens não fecha a referência das formas. A fórmula, a margem de 20%, o motor F×NF, as fichas, o seletor de empresa e o contrato pastel → residual → refrigerante não foram alterados.

O comando `node --test tests/pdv` não aceita a pasta como suíte nesta versão do Node. Os arquivos foram executados um a um, com `--test-concurrency=1`.

O isolamento usado é o helper já adotado nas Sprints 26 a 32 (`isolarBancoTeste`). A evidência integrada ficou em `C:\Users\cicer\AppData\Local\Temp\cds-sprint34-4wDHig\mercadao.db`. `dados/mercadao.db`, `backend/banco/mercadao.db` e o banco oficial não foram abertos nem alterados.

## 3. Regra de classificação

| Forma | Tipo gravado | Quando |
|---|---|---|
| PIX, débito, crédito e demais formas que exigem autorizador | `fiscal` | Somente se `parcelaEfetivamenteConfirmada` |
| Dinheiro, espécie ou cash | `nao_fiscal` | Confirmação manual válida, inclusive com `aprovado: false` |
| A prazo e demais formas fora dessas duas | o tipo que o orquestrador já calculou | Não há conversão automática para fiscal |

A ordem das parcelas não entra na regra. Pendente, rejeitado, negado ou falha devolvem `null`: o recebimento não é reclassificado como fiscal e não é tratado como dinheiro.

## 4. Classificação e confirmação

`tipo_recebimento` diz a natureza da forma. `status`, `aprovado` e a autorização da distribuição dizem se o valor entra na referência e se a NFC-e pode ser montada.

Um PIX pendente continua sendo PIX. Ele não soma em `valor_fiscal_referencia` e não vira dinheiro. O dinheiro confirmado soma só no não fiscal, tenha a distribuição sido aplicada ou não. O bloqueio `DISTRIBUICAO_NAO_AUTORIZADA` ou `RECOMPOSICAO_NAO_AUTORIZADA` impede a emissão. Ele não reescreve o tipo das parcelas.

## 5. Emissor antes e depois

**Antes.** Sem `valor_fiscal` e `valor_nao_fiscal` positivos, e sem um tipo não fiscal já gravado, a venda mista não exigia separação. Parcela sem tipo entrava no pagamento da NFC-e. O dinheiro podia sair como `tPag` 01. O carrinho comercial integral continuava disponível para quem não passasse pela guarda de itens.

**Depois.** Dinheiro confirmado junto com PIX, débito ou crédito confirmado exige separação, mesmo com os totais da venda ainda em zero e sem tipo persistido. Tipos `fiscal` e `nao_fiscal` no mesmo conjunto também exigem separação. Nesse contexto, dinheiro e parcela sem tipo ficam fora de `resolverPagamentosNfce`. Se o filtro ficar vazio, o builder não inventa dinheiro. A guarda de itens continua devolvendo `DISTRIBUICAO_NAO_AUTORIZADA` quando a soma de `valor_fiscal` dos itens não fecha a referência das formas. Venda só eletrônica e venda só em dinheiro seguem o caminho anterior. A prazo permanece em `outros` e fora do pagamento fiscal.

## 6. Resultado dos 12 cenários

| # | Resultado |
|---|---|
| 1 | PIX aprovado classificado `fiscal`, dinheiro `nao_fiscal`. Venda gravada com `valor_fiscal` 0. Emissão sem XML (`status` diferente de `xml_preparado`). |
| 2 | Débito aprovado classificado `fiscal`. No fechamento sem autorização, a linha persistida ficou `fiscal`. |
| 3 | Crédito aprovado classificado `fiscal`. No fechamento sem autorização, a linha persistida ficou `fiscal`. |
| 4 | PIX, débito, crédito e dinheiro mantêm os mesmos tipos em qualquer ordem. |
| 5 | A assinatura forma:tipo com dinheiro primeiro é igual à assinatura com os eletrônicos primeiro. |
| 6 | PIX pendente não é confirmado. A referência fiscal fica 0. O dinheiro confirmado ao lado continua não fiscal. |
| 7 | Débito rejeitado não é confirmado e não entra como fiscal. |
| 8 | Somente dinheiro confirmado: referência fiscal 0 e não fiscal igual ao total. |
| 9 | Somente PIX aprovado: referência fiscal igual ao total e não fiscal 0. |
| 10 | Com `CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR=1`, a venda 2 gravou fiscal 50 e não fiscal 10. O XML sintético saiu com `vProd` 50, `vNF` 50 e pagamentos 20 + 20 + 10. |
| 11 | Venda mista com itens comerciais integrais e totais zerados: `separacaoExigida` verdadeiro, dinheiro fora dos pagamentos e `selecionarItensFiscaisParaNfce` devolve `DISTRIBUICAO_NAO_AUTORIZADA`. |
| 12 | A mesma `chave_fechamento_pdv` devolveu o mesmo `venda_id`, com `venda_ja_persistida`. |

## 7. Regressões

Execução sequencial, `--test-concurrency=1`.

| Suíte | Resultado |
|---|---|
| Sprint 34 | 4 testes, 0 falha |
| Sprint 26 | 8 testes, 0 falha |
| Sprint 28 | 8 testes, 0 falha |
| Sprint 29 | 9 testes, 0 falha |
| Sprint 31 | 5 testes, 0 falha |
| Sprint 32 | 4 testes, 0 falha |
| Sprint 25, depois do ajuste do cenário C | 6 testes, 0 falha |
| Demais arquivos de `tests/pdv` já concluídos na passagem | ver notas abaixo |
| `tests/vendas`, arquivo a arquivo | contratos puros de recomposição com 0 falha; ver notas |

Notas da passagem por `tests/pdv`:

- Concluídos com 0 falha nesta sprint: empresa única 02, 04 e 06; valor pastéis 02; fluxo direto; orquestração do pagamento direto; foto miniatura; multiempresa 04, 05, 06, 07, 08, 10 entrega, 10 faturamento, 12, 13 e 14; timeout de venda; seleção 01 e 03; busca PLU; Sprint 21 etapas G e I; vínculo TEF; Sprints 22, 23, 24, 25 interação, 27 e campo de valor.
- Falhas anteriores a esta sprint, sem alteração de `pdv.js`: `pdv-multiempresa-09` (texto de mensagem da UI), `pdv-sel-02` (saldo não fiscal insuficiente na empresa) e `sprint-21-etapa-b` (`headersPedidoPdv is not defined` e `processarVendaFiscalManual is not defined` no eval da tela).
- `sprint-21-etapa-c` permaneceu preso em modal da interface e foi interrompido. Não faz parte do contrato da recomposição.

O cenário C da Sprint 25 esperava `valor_fiscal` 50 numa venda com débito, crédito e dinheiro sem distribuição autorizada. Desde a Sprint 31 esse fechamento zera o fiscal e bloqueia a NFC-e. A asserção foi alinhada a esse contrato: total 50, fiscal 0, não fiscal 50, documento bloqueado, débito e crédito `fiscal`, dinheiro `nao_fiscal`, e as três parcelas da lista preservadas. O valor 40, que seria total menos dinheiro, continua rejeitado.

`tests/vendas` também não roda como pasta. Os arquivos `cds-pagamento-misto-recomposicao-fiscal-02` a `17`, `19` e `20`, além de composição, cotação, saldos, MPFC de infraestrutura e preservação de dinheiro da Sprint 38B, terminaram com 0 falha. Vários arquivos antigos carregam `backend/database.js` sem definir `DB_DIR` antes. Sob `node --test`, o guardião recusa o fallback para ProgramData e o arquivo aborta com `CDS_BANCO_OFICIAL_BLOQUEADO`. Isso ocorreu em `fiscal-402-desconto-pagamento`, `pagamento-nao-fiscal-idempotencia`, `rc7101-valor-fiscal-liquido`, `sprint38a-midp-infra`, `sprint38c-midp-preservar-dinheiro` e `venda-mista-pagamento-integral`. O banco oficial não foi aberto. Esses arquivos não foram adaptados nesta sprint.

## 8. Valores persistidos

Banco de evidência: `C:\Users\cicer\AppData\Local\Temp\cds-sprint34-4wDHig\mercadao.db`. Total comercial R$ 60,00. Catálogo do teste: pastel a R$ 10,00 e um refrigerante de 200 ml a R$ 5,00. A quantidade fiscal do refrigerante saiu do motor, 6 unidades, e não foi fixada no teste.

**Venda 1, sem autorização**

| Campo | Valor |
|---|---:|
| total | 60 |
| valor_fiscal | 0 |
| valor_nao_fiscal | 60 |
| PIX | 20, `fiscal` |
| Débito | 20, `fiscal` |
| Crédito | 10, `fiscal` |
| Dinheiro | 10, `nao_fiscal` |
| Quantidade fiscal dos itens | 0 |

**Venda 2, distribuição autorizada**

| Campo | Valor |
|---|---:|
| total | 60 |
| valor_fiscal | 50 |
| valor_nao_fiscal | 10 |
| Pastel | quantidade 2, fiscal 2, valor fiscal 20 |
| Refrigerante | quantidade comercial 8, fiscal 6, valor fiscal 30, não fiscal 2, valor não fiscal 10 |
| Tipos | PIX, débito e crédito `fiscal`; dinheiro `nao_fiscal` |

## 9. Bloqueio sem autorização

A venda 1 foi persistida uma vez. A repetição da chave `pdv-sprint34-sem-auth` devolveu o mesmo identificador. `documento_fiscal.bloqueado` veio verdadeiro. `emitirPorVendaId` com `naoTransmitir: true` não produziu `xml_preparado`. A guarda de itens, no cenário 11, devolve o código `DISTRIBUICAO_NAO_AUTORIZADA`.

## 10. XML sintético com distribuição autorizada

Emissão local, sem certificado e sem transmissão. Trechos conferidos no XML da venda 2:

- `vProd` 50.00 e `vNF` 50.00
- `tPag` 17 com `vPag` 20.00
- `tPag` 04 com `vPag` 20.00
- `tPag` 03 com `vPag` 10.00
- nenhum `tPag` 01
- `qCom` inteiro em todos os itens
- `ICMSTOT` com `vDesc` 0, `vProd` 50, `vNF` 50 e soma dos itens 50

## 11. Flag de produção

`RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece `false` em `backend/services/vendas/RecomposicaoFiscalContratoService.js`. A variável de homologação interna não foi gravada em código de produto. Ela só foi ligada no processo do teste autorizado e removida no teste sem autorização.

## 12. Pendências de homologação manual

- Conferir no PDV habitual de testes o fechamento com dinheiro, PIX, débito e crédito, na ordem que o operador informar.
- Confirmar na tela que a venda sem distribuição autorizada permanece gravada, com os tipos corretos, e que a NFC-e não é emitida.
- Confirmar visualmente o XML e o cupom quando a distribuição de homologação estiver ligada no ambiente de teste.
- Não declarar esta sprint homologada operacionalmente.
