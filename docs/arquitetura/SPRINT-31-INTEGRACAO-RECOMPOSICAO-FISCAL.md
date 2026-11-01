# Sprint 31 — Integração da referência financeira, distribuição F×NF e XML NFC-e

Implementação e testes em banco temporário. A homologação visual e operacional permanece com o usuário. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` continua `false`. Nenhum TEF, PIX, adquirente ou documento foi enviado à SEFAZ. O banco oficial não foi aberto.

## 1. Causa de cada problema

1. **Dinheiro confirmado manualmente saía da referência.** `PagamentoSequencial.exportar` gravava `aprovado: false` em toda parcela que não estivesse com status `aprovada`. O classificador do backend tratava esse campo como rejeição antes de olhar a forma. O dinheiro informado pelo operador, portanto, não somava no não fiscal, e a referência ficava 50/0 em vez de 50/10.
2. **A referência não alterava a persistência.** `criarVenda` chamava o distribuidor exclusivo com `vendaFiscal === true`. Todos os itens comerciais iam para o bucket fiscal. A referência da Sprint 26 ficava anexada, com `aplica_ao_fluxo_oficial` desligado.
3. **O emissor dependia só da variável de teste.** Sem `CDS_RECOMPOSICAO_REFERENCIA_TESTE`, `emitirPorVendaId` montava a NFC-e com as linhas persistidas. Como essas linhas eram o carrinho inteiro, `vProd` e `vNF` saíam iguais ao total comercial.
4. **Pagamento sem tipo entrava na NFC-e.** `resolverPagamentosNfce` tratava parcela sem `tipo_recebimento` como fiscal. O dinheiro virava `tPag` 01.

## 2. Arquivos alterados

- `frontend/pdv/js/pagamentoSequencial.js` — contrato real de `exportar`.
- `frontend/pdv/js/pdv.js` — a lista sequencial marca dinheiro como `nao_fiscal` e o eletrônico autorizado como `fiscal`.
- `backend/services/vendas/PagamentoSequencialComposicaoService.js` — dinheiro confirmado manualmente entra na referência mesmo com `aprovado: false`.
- `backend/services/vendas/PagamentoRecomposicaoDocumentoService.js` — a conferência das parcelas usa a mesma regra.
- `backend/services/vendas/VendaPagamentoService.js` — a composição autorizada substitui o bucket exclusivo antes da gravação.
- `backend/services/vendas/VendaFiscalService.js` — a resposta leva o bloqueio fiscal, quando existe.
- `backend/services/fiscal/emissor.js` — a NFC-e só segue se a distribuição persistida fecha a referência.
- `backend/services/fiscal/xmlBuilder.js` — no contexto de separação, dinheiro e parcela sem tipo ficam fora do pagamento do documento.
- `tests/pdv/sprint-31-integracao-recomposicao-fiscal.test.js` — teste integrado novo.

Não foi criado outro motor financeiro, comercial, de composição ou de distribuição.

## 3. Contratos

**Antes.** Dinheiro exportado com `aprovado: false` não contava. Venda fiscal persistia quantidade e valor fiscais iguais aos comerciais. O emissor usava essa lista. Parcela sem tipo entrava no XML.

**Agora.**

- Dinheiro com status `informada`, confirmação manual ou `tipo_recebimento: 'nao_fiscal'` conta como recebimento não fiscal. Não exige `tef_transacao_id`.
- PIX, débito e crédito continuam exigindo autorização efetiva. `aprovado: false`, pendente, rejeitada ou falha ficam fora da referência.
- Fiscal é a soma do eletrônico confirmado. Não fiscal é a soma do dinheiro confirmado. A referência não é calculada subtraindo o dinheiro do total.
- Com separação e distribuição autorizada, a gravação usa as quantidades e os valores devolvidos pelo distribuidor oficial. Cada item conserva a quantidade comercial, a fiscal e a não fiscal.
- Sem composição, sem saldo na empresa da venda ou sem autorização, a venda financeira é mantida, o identificador não muda e as quantidades fiscais ficam zeradas. A resposta traz `documento_fiscal.bloqueado` e o código. Não nasce uma segunda venda.
- O emissor compara a soma de `valor_fiscal` persistido com a referência calculada dos recebimentos. Divergência devolve `DISTRIBUICAO_NAO_AUTORIZADA` e não monta o XML. A variável de teste não é a condição dessa conferência.
- No contexto de separação, dinheiro e parcela sem tipo não entram em `resolverPagamentosNfce`. O valor de um pagamento único não é reescrito para fechar `vNF`.

## 4. Fluxo integrado

1. `PagamentoSequencial.exportar` classifica cada parcela.
2. `calcularReferenciasConfirmadas` soma fiscal e não fiscal.
3. Havendo os dois lados e o ambiente de teste ligado, `criarVenda` chama `integrarPagamentoRecomposicao` com os itens comerciais, o banco e a empresa da venda. O catálogo não vem do corpo da requisição.
4. O pastel da categoria `PASTEIS` permanece. O residual é a referência fiscal menos o pastel.
5. `buscarComposicao` devolve a combinação do catálogo ativo.
6. A proposta validada segue para `encaminharPropostaValidadaAoDistribuidorOficial`, que consulta o saldo da empresa da venda.
7. Só o resultado autorizado é gravado.
8. O reenvio da mesma `chave_fechamento_pdv` devolve a venda existente e não repete a composição.
9. `emitirPorVendaId` lê as linhas persistidas. `buildNfceXml` recebe apenas as que têm quantidade e valor fiscais. No teste, `naoTransmitir` devolve o XML antes do certificado e da SEFAZ.

Sem o ambiente de teste, ou sem a autorização do distribuidor, o fluxo para no bloqueio explícito. A variável de teste não completa uma composição ausente.

## 5. Evidência de persistência

Banco temporário. Carrinho do teste, não o da nota 1022: pastel R$ 10, quantidade 2; um refrigerante de catálogo a R$ 5, quantidade 8. Total comercial R$ 60. Pagamentos: PIX 20, débito 20, crédito 10, dinheiro 10.

Venda persistida no cenário principal: identificador 5 no último teste.

| Produto | Quantidade comercial | Valor comercial | Quantidade fiscal | Valor fiscal | Quantidade não fiscal | Valor não fiscal |
|---|---:|---:|---:|---:|---:|---:|
| Pastel de teste | 2 | 20,00 | 2 | 20,00 | 0 | 0,00 |
| Refrigerante teste 200 | 8 | 40,00 | 6 | 30,00 | 2 | 10,00 |

`vendas.valor_fiscal = 50`. `vendas.valor_nao_fiscal = 10`.

Recebimentos gravados: PIX, débito e crédito com `tipo_recebimento = fiscal`; dinheiro com `tipo_recebimento = nao_fiscal`.

## 6. Resultado do distribuidor oficial

Empresa da venda, não a segunda empresa semeada com saldo. Pastel fixo: 2 × R$ 10 = R$ 20. Residual fiscal: R$ 50 − R$ 20 = R$ 30. O catálogo temporário tinha um modelo ativo de refrigerante, R$ 5 e 200 ml. O motor encontrou 6 unidades, R$ 30. A proposta autorizada foi pastel 2 no fiscal e refrigerante 6 no fiscal. As 2 unidades restantes do refrigerante, R$ 10, ficaram no não fiscal. O saldo da outra empresa não foi usado.

## 7. XML sintético

Gerado por `emitirPorVendaId` com `naoTransmitir: true`. Não houve assinatura nem envio.

- Itens: pastel quantidade 2, `vProd` 20,00; refrigerante quantidade 6, `vProd` 30,00.
- `vProd` 50,00.
- `vNF` 50,00.
- Pagamentos: `tPag` 17 de 20,00, `tPag` 04 de 20,00, `tPag` 03 de 10,00.
- Não há `tPag` 01.
- Soma de `vPag` = 50,00.

A origem da lista é a distribuição persistida da venda. O carrinho comercial, se reapresentado com valor fiscal 60, é recusado com `DISTRIBUICAO_NAO_AUTORIZADA`.

## 8. Testes executados

`node --test --test-concurrency=1 tests/pdv/sprint-31-integracao-recomposicao-fiscal.test.js`

5 testes, 0 falhas. Banco `cds-sprint31-*` em diretório temporário.

| Cenário | Resultado |
|---|---|
| Exportação real, dinheiro na última e na primeira parcela, `aprovado: false` com confirmação manual | Referência correta |
| Venda só em dinheiro | Fiscal 0, não fiscal 60 |
| Venda só eletrônica, transação simulada | Fiscal 60, não fiscal 0 |
| PIX, débito, crédito e dinheiro | Fiscal 50, não fiscal 10 |
| Parcela eletrônica pendente ou rejeitada | Fora da referência |
| Sem pastel elegível | `SEM_PASTEL_ELEGIVEL`, fiscal 0 |
| Sem modelo ativo | `COMPOSICAO_AUSENTE_NO_MOTOR` |
| Saldo fiscal insuficiente na empresa da venda, saldo existente em outra empresa | Bloqueio, saldo da outra empresa intocado |
| Sem autorização do distribuidor | `AUTORIZACAO_AUSENTE`, venda preservada |
| Ambiente de teste desligado | `RECOMPOSICAO_NAO_AUTORIZADA`, fiscal 0 |
| Distribuição autorizada | Persistida e usada no XML |
| Carrinho comercial sem essa distribuição | XML bloqueado |
| Divergência entre itens e total autorizado | `DISTRIBUICAO_NAO_AUTORIZADA` |
| Mesma `chave_fechamento_pdv` | Mesmo identificador, itens não duplicados |
| Emissão sem transmissão | XML da venda original, sem segunda venda |

## 9. Regressões

Executadas em sequência, cada uma no próprio banco temporário.

| Suíte | Resultado |
|---|---|
| Sprint 26 | 8 testes, 0 falhas |
| Sprint 28 | 8 testes, 0 falhas |
| Sprint 29 | 9 testes, 0 falhas |

## 10. Limitações

- A flag de produção permanece desligada. A distribuição autorizada, no fechamento, depende do ambiente de teste e de `CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR` no processo do servidor. Essas variáveis não foram gravadas em configuração de produção.
- Sem essas condições, a venda mista é preservada com quantidades fiscais zeradas e um código de bloqueio. Ela não é apresentada como NFC-e concluída.
- Quando a composição é bloqueada, o estoque não é baixado. A baixa errada foi evitada. A venda continua existindo para diagnóstico, sem duplicidade no reenvio.
- O cenário principal usa o catálogo semeado no banco temporário. A quantidade de refrigerante é a que o motor encontrou para o residual, não um valor copiado de venda real.
- `naoTransmitir` existe apenas para o teste provar o XML. O caminho sem essa opção continua o de emissão real e não foi exercido.
- A homologação na tela do PDV e em operação não foi feita.

## Idempotência

O reenvio da chave `pdv-sprint31-principal` devolveu o identificador 5, com `venda_ja_persistida: true`, e a contagem de itens permaneceu a mesma.
