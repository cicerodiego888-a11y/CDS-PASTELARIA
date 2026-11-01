# Auditoria 33 — rastreamento da venda 1022 e da NFC-e de R$ 60,00

Auditoria somente. Nenhum registro foi alterado. O banco oficial não foi aberto. Não houve TEF, PIX, transmissão nem evento à SEFAZ. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece `false`. Nenhuma correção foi implementada.

## 1. Identificação da venda e da empresa

O número 1022 foi procurado como `vendas.id`, `nfce_notas.id`, `nfce_notas.numero` e `nfce_notas.venda_id`.

| Banco consultado | Vendas | Maior id | NFC-e | Maior número | Nota 1022 |
|---|---:|---:|---:|---:|---|
| `dados/mercadao.db` do projeto | 9 | 9 | 2 | 2 | ausente |
| `backend/banco/mercadao.db` do projeto | 167 | 167 | 47 | 47 | ausente |
| `Temp/cds-pdv-testes/banco/mercadao.db` | 0 | — | 0 | — | ausente |
| `Temp/cds-sistemas-test-db/mercadao.db` | 0 | — | 0 | — | ausente |
| `Temp/cds-central-entradas-testes/mercadao.db` | 0 | — | 0 | — | ausente |

Os produtos 747, 748 e 749 também não existem nesses bancos. Empresa, CNPJ, data, chave de fechamento e documento fiscal da nota 1022 não foram lidos. Eles estão no banco operacional, que o `electron.js` aponta para `ProgramData\MercantilFiscal\dados`. Esse arquivo não foi aberto.

O que existe sobre a nota é o XML já descrito na Auditoria 30 e a reprodução daquele caminho. Não há linha persistida da venda 1022 fora do banco oficial.

## 2. Pagamentos persistidos

Não há parcela da venda 1022 nos bancos de teste consultados. A forma do XML informado continua sendo a evidência dos pagamentos que entraram no documento:

| Pagamento | Valor | No XML 1022 |
|---|---:|---|
| PIX | R$ 20,00 | `tPag` 17, dentro da NFC-e |
| Débito | R$ 20,00 | `tPag` 04, dentro da NFC-e |
| Crédito | R$ 10,00 | `tPag` 03, dentro da NFC-e |
| Dinheiro | R$ 10,00 | `tPag` 01, dentro da NFC-e |

A classificação esperada do dinheiro é não fiscal. O XML não mostra essa exclusão.

## 3. Referência financeira

Não há linha de `venda_composicao_referencia` ligada à nota 1022 nos bancos consultados.

No processo que emite pelo Electron, `CDS_RECOMPOSICAO_REFERENCIA_TESTE` não é definida. `avaliarReferenciaRecomposicao` então devolve `recomposicao_executada: false`, totais `null` e motivo `ambiente_teste_desligado`. A referência de R$ 50,00 / R$ 10,00 não chega a ser gravada nesse processo. A Auditoria 30 reproduziu esse retorno com a porta fechada.

## 4. Itens persistidos

Não há `vendas_itens` da nota 1022 nos bancos de teste. Os produtos 747, 748 e 749 não foram encontrados neles. A comparação possível é a do XML com a reprodução do distribuidor exclusivo, já registrada na Auditoria 30:

| Item no XML | Quantidade | Valor |
|---|---:|---:|
| Pastel do Cheff | 2 | 16,92 |
| Refrigerante Copo 200 ml | 2 | 24,45 |
| Refrigerante Copo 300 ml | 1 | 18,63 |
| Total | | 60,00 |

Não há quantidade não fiscal nem valor não fiscal nesse desenho. A ficha técnica desses produtos não foi lida, porque o cadastro da nota está no banco oficial.

## 5. Flags e autorizações lidas pelo processo

| Nome | Valor no processo do PDV |
|---|---|
| `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` | `false`, constante do código |
| `CDS_RECOMPOSICAO_REFERENCIA_TESTE` | ausente; o Electron não define |
| `CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR` | ausente |
| `CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO` | ausente; se fosse `1`, `obterAutorizacaoDistribuicaoOficialInterna` ainda recusa |
| Harness de distribuição | ausente |

`obterAutorizacaoDistribuicaoOficialInterna` só autoriza o distribuidor de recomposição com harness de teste ou com `CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR=1`. Nenhum dos dois existe na subida do aplicativo. A distribuição da recomposição não foi autorizada na emissão operacional.

## 6. Caminho do fechamento que gerou a nota

A nota saiu com `vNF` 60 e `tPag` 01. Esse resultado só fecha com o caminho anterior à guarda da Sprint 31:

1. O PDV enviou o carrinho comercial em `POST /api/vendas`.
2. A porta de teste estava desligada, então a referência não foi executada.
3. `criarVenda` chamou `distribuirItensVendaComValorFiscalEfetivo` com `vendaFiscal === true`.
4. Cada item comercial foi gravado inteiro em `quantidade_fiscal` e `valor_fiscal`.
5. `encaminharPropostaValidadaAoDistribuidorOficial` não entrou nesse caminho.
6. `responderVendaComFiscal` emitiu porque havia valor fiscal maior que zero.

A distribuição da recomposição foi ignorada, não bloqueada e não autorizada. O ponto responsável é a chamada do distribuidor exclusivo em `VendaPagamentoService.js` quando `recomposicao_executada` não é verdadeiro.

## 7. Caminho do emissor que montou o XML

Na versão que emitiu a nota, `emitirPorVendaId` carregava `vendas_itens` e só trocava a lista se `CDS_RECOMPOSICAO_REFERENCIA_TESTE` fosse `1`. A variável estava ausente. `itemEntraNaNfce` aceitou as três linhas porque `quantidade_fiscal` e `valor_fiscal` eram os valores comerciais. `resolverPagamentosNfce` tratava parcela sem `tipo_recebimento` como fiscal. O ramo sequencial não gravava esse tipo. O dinheiro entrou como `tPag` 01.

O bloqueio de composição indisponível não rodou. `integrarPagamentoRecomposicao`, com a porta fechada, devolve `bloqueado: false` no sentido de “não apliquei e não impeço o fechamento”. A condição que permitiu o XML foi a combinação de itens já gravados como fiscais e pagamentos sem tipo não fiscal.

## 8. Comparação com o XML 1022

| Campo | XML 1022 | Caminho exclusivo reproduzido na Auditoria 30 |
|---|---:|---:|
| `vProd` | 60,00 | 60,00 |
| `vNF` | 60,00 | 60,00 |
| `vPag` | 60,00 | 60,00 |
| `tPag` | 17, 04, 03, 01 | 17, 04, 03, 01 |

Os R$ 60,00 são a soma do carrinho comercial gravado no bucket fiscal. Os R$ 10,00 de dinheiro não foram excluídos porque o pagamento não tinha `tipo_recebimento: 'nao_fiscal'` e o montador da Sprint 28, que marca esse tipo, não montou essa nota.

## 9. Causa raiz e o que ainda falta

A causa do XML está comprovada pelo formato da nota e pela reprodução do caminho com a porta de teste fechada: a venda inteira foi fiscalizada pelo distribuidor exclusivo e o emissor usou essa lista, com o dinheiro incluído por falta de tipo.

Ainda falta a linha real da venda 1022: id interno, empresa, CNPJ, data, chave de fechamento, parcelas gravadas e quantidades fiscais. Essa leitura exigiria o banco oficial e não foi feita.

## 10. Código atual e menor correção, sem implementá-la

As Sprints 31 e 32 mudaram o fechamento novo. No banco temporário já existente `Temp/cds-sprint31-3VJkm0/mercadao.db`, a venda 5, que não é a 1022, ficou com valor fiscal 50, valor não fiscal 10, dinheiro `nao_fiscal` e refrigerante 6 fiscal / 2 não fiscal. As vendas 3 e 4, sem autorização do distribuidor, ficaram com quantidade fiscal 0 e não geraram NFC-e. Nesse bloqueio, PIX, débito e crédito também foram gravados como `nao_fiscal`, porque a reclassificação por forma só ocorre quando a distribuição foi aplicada.

O código atual, se reemitisse uma venda antiga com itens fiscais de R$ 60,00 e parcelas em dinheiro mais eletrônicas, pararia em `selecionarItensFiscaisParaNfce` com `DISTRIBUICAO_NAO_AUTORIZADA`, antes do XML. `resolverPagamentosNfce` ainda só exige separação quando já existe tipo não fiscal ou quando `valor_fiscal` e `valor_nao_fiscal` persistidos são ambos positivos. Numa venda antiga com valor não fiscal 0 e sem tipo, o filtro de pagamento, sozinho, ainda deixaria o dinheiro passar. A guarda dos itens é o que impede o XML hoje.

Menor correção recomendada, não feita nesta auditoria:

1. Não reemitir a nota 1022 a partir do carrinho comercial.
2. Na persistência bloqueada, gravar o tipo de cada recebimento pela forma, para o diagnóstico não transformar PIX, débito e crédito em não fiscal.
3. Fazer `vendaExigeSeparacaoDePagamento` usar a mesma classificação por forma da referência, e não só os totais já gravados na venda.
4. Manter a flag de produção desligada. Não converter a margem de 20% em desconto.

## Divergência entre Sprint 31 e Sprint 32

O pagamento misto e o pagamento direto chamam o mesmo `solicitarAvaliacaoComposicaoPagamento` e a mesma rota `composicao-sequencial`. A Sprint 32 acrescenta o aviso na tela e suspende a composição enquanto houver parcela digital pendente. Não altera a fórmula 50/10 nem a regra dos 20%.

A divergência que permanece no fechamento bloqueado é a gravação de todos os recebimentos como não fiscal, vista nas vendas 3 e 4 do banco temporário da Sprint 31. A venda autorizada, de número 5 nesse mesmo banco, separa os tipos corretamente.

## Consultas e verificações

Consultas somente leitura, com `sqlite3.OPEN_READONLY`:

- `nfce_notas` por `numero`, `id` ou `venda_id` iguais a 1022.
- `vendas` por `id` 1022.
- `COUNT` e `MAX` de vendas e de NFC-e.
- `produtos` de ids 747, 748 e 749.
- No banco temporário da Sprint 31: `vendas`, `vendas_itens` e `venda_recebimentos`.

Arquivos lidos: `electron.js`, `RecomposicaoFiscalContratoService.js`, `RecomposicaoFiscalFechamentoAdaptadorService.js`, `VendaPagamentoService.js`, `emissor.js`, `xmlBuilder.js` e a Auditoria 30.

Nenhum teste novo foi executado e nenhum banco foi criado. O script de leitura ficou fora do repositório e não gravou nos arquivos consultados.
