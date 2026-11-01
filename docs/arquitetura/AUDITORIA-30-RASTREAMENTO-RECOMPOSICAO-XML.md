# Auditoria 30 — rastreamento da referência financeira até o XML da NFC-e

Auditoria somente. Nenhum arquivo de produção foi alterado. O banco oficial não foi aberto. Não houve TEF, PIX, emissão real nem envio à SEFAZ. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece `false`.

Correlação da reprodução: `AUD30-NFCE-1022`.

## 1. Causa raiz

A NFC-e nº 1022 saiu com os itens comerciais integrais porque o emissor montou o XML a partir das linhas já gravadas em `vendas_itens` pelo distribuidor exclusivo, com a venda inteira no bucket fiscal. A referência da Sprint 26 não entra nessa gravação e não entra na montagem do XML enquanto `CDS_RECOMPOSICAO_REFERENCIA_TESTE` não está em `1`.

Os R$ 10,00 de dinheiro deixam de ser separados na persistência da venda, em `criarVenda`, na chamada:

`distribuirItensVendaComValorFiscalEfetivo(entradas, vendaFiscal, opcoes)`

`vendaFiscal` fica verdadeiro quando o corpo traz `venda_fiscal` ou, na ausência dele, `emitir_fiscal`. O distribuidor oficial é exclusivo: com `vendaFiscal === true`, cada item comercial vai inteiro para `quantidade_fiscal` e `valor_fiscal`. O dinheiro não reduz quantidade nem valor.

A referência, quando chega a ser calculada, é gravada à parte em `venda_composicao_referencia` com `aplica_ao_fluxo_oficial: false` e `distribuicao_oficial_alterada: false`. Ela não substitui `resultadoMotor`.

O XML observado fecha essa explicação:

| Campo | NFC-e 1022 | Reprodução com a porta de teste fechada |
|---|---:|---:|
| `vProd` | 60,00 | 60,00 |
| `vNF` | 60,00 | 60,00 |
| `vPag` | 60,00 | 60,00 |
| `tPag` | 17, 04, 03 e 01 | 17, 04, 03 e 01 |

O dinheiro aparece como `tPag=01` dentro do documento. O montador da Sprint 28 marca dinheiro como `tipo_recebimento: 'nao_fiscal'`, e `resolverPagamentosNfce` exclui esse tipo. O XML 1022 não passou por esse montador.

Cenários da auditoria:

| Cenário | Situação nesta nota |
|---|---|
| A. Recomposição não executada | Confirmado no processo que emite. A porta do emissor não chama o serviço. |
| B. Recomposição bloqueada | Não foi o caminho da nota. Com a porta ligada e sem modelo, o código é `COMPOSICAO_AUSENTE_NO_MOTOR` e o XML não sai. A nota 1022 saiu. |
| C. Resultado descartado | Não houve resultado do distribuidor de recomposição para descartar. O fechamento usa o motor exclusivo desde o início. |
| D. Emissor ignora a lista fiscal | Confirmado como desenho atual: sem a variável de teste, `itensDocumento` permanece a lista carregada de `vendas_itens`. |
| E. Configuração desabilitada | Confirmado. A variável de teste não é definida na subida do aplicativo. A flag de produção está falsa no código. |
| F. Persistência sem as quantidades fiscais da referência | Confirmado. O que é persistido é a distribuição exclusiva, não a composição pastel → residual → refrigerantes. |

## 2. Fluxo real

1. O PDV registra PIX, débito e crédito só depois do autorizador. Dinheiro entra com `status_autorizacao: 'informada'`. `PagamentoSequencial.exportar` grava `aprovado: false` nessa parcela, porque `aprovado` só fica verdadeiro quando o status é `aprovada`.
2. `frontend/pdv/js/pdv.js`, `solicitarAvaliacaoComposicaoPagamento`, envia total, parcelas e `itensCarrinhoParaComposicao()` para `POST /api/vendas/composicao-sequencial`. A resposta só alimenta `pdvDocumentoFiscalBloqueado`. O carrinho enviado em `POST /api/vendas` continua comercial.
3. `backend/rotas/vendas.js`, `POST /composicao-sequencial`, chama `avaliarReferenciaRecomposicao`. Só chama `integrarPagamentoRecomposicao` se `recomposicao_executada === true` e houver itens. A rota não emite.
4. `avaliarReferenciaRecomposicao`, em `PagamentoSequencialComposicaoService.js`, calcula fiscal e não fiscal apenas se `CDS_RECOMPOSICAO_REFERENCIA_TESTE === '1'` e a flag de produção não for verdadeira. Fora disso devolve `recomposicao_executada: false`, referências `null` e `motivo_recomposicao: 'ambiente_teste_desligado'`. Mesmo quando calcula, chama `avaliarCandidatoComBuscarComposicao` com `modelos: []` e devolve `aplica_ao_fluxo_oficial: false`.
5. `criarVenda`, em `VendaPagamentoService.js`, pode guardar essa avaliação. Em seguida chama o distribuidor exclusivo com `vendaFiscal`. `inserirItensDaVenda` grava `quantidade_fiscal` e `valor_fiscal` desse resultado. A recomposição da Sprint 28 não é chamada nesse `POST`.
6. `responderVendaComFiscal` chama `emitirPorVendaId` quando `emitir_fiscal` é verdadeiro e `valor_fiscal > 0`.
7. `backend/services/fiscal/emissor.js`, `emitirPorVendaId`, carrega `vendas_itens` em `carregarVenda`. A troca por `integrarPagamentoRecomposicao` só ocorre dentro de `if (CDS_RECOMPOSICAO_REFERENCIA_TESTE === '1')`. Com a variável ausente, `itensDocumento` segue sendo a lista comercial já fiscalizada pelo distribuidor exclusivo.
8. `itemEntraNaNfce` aceita linha com `quantidade_fiscal > 0` e `valor_fiscal > 0`. As três linhas da nota passam.
9. `buildNfceXml` usa `obterValorFiscalItem` (`valor_fiscal`) e `obterQuantidadeFiscalItem` (`quantidade_fiscal`). `resolverPagamentosNfce` trata pagamento sem `tipo_recebimento` como fiscal. O ramo sequencial do PDV não grava `tipo_recebimento` nas parcelas. PIX, débito, crédito e dinheiro entram no `<pag>`.

`encaminharPropostaValidadaAoDistribuidorOficial` não participa desse caminho. Ele só é alcançado por `PagamentoRecomposicaoDocumentoService.distribuirProposta`, depois de referência executada, pastel `PASTEIS`, residual não negativo e `buscarComposicao` com `distribuicao_possivel === true`.

## 3. Configuração efetivamente carregada

Não há arquivo `.env` no repositório. `electron.js` define `DB_DIR` e não define as variáveis de recomposição. O processo filho de impressão herda `process.env` e também não as cria. A flag de produção é a constante `false` em `RecomposicaoFiscalContratoService.js`. Ela não é lida de ambiente.

Na reprodução, antes de qualquer `require` do backend, as variáveis foram removidas e o banco foi um diretório temporário:

| Nome | Valor carregado |
|---|---|
| `CDS_RECOMPOSICAO_REFERENCIA_TESTE` | ausente |
| `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` | `false` |
| `CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR` | ausente |
| Harness do distribuidor | ausente |
| Porta do emissor | fechada |
| Banco | temporário, não oficial |

Empresa, CNPJ e categoria cadastrada do “Pastel do Cheff” da nota 1022 não foram lidos. Isso exigiria o banco oficial. A categoria usada na reprodução foi informada só como hipótese de código, não como dado da venda real.

O terminal local tinha executado `npm start`, mas o trecho capturado não contém o log da NFC-e 1022. A forma do XML, e não um log desse processo, é a evidência de qual caminho rodou.

## 4. Referência financeira

Com a porta fechada, para PIX 20 + débito 20 + crédito 10 + dinheiro 10:

- `recomposicao_executada`: `false`
- fiscal: `null`
- não fiscal: `null`
- motivo: `ambiente_teste_desligado`

Com a porta ligada só dentro da chamada, e sem `aprovado: false` no dinheiro:

- fiscal: R$ 50,00
- não fiscal: R$ 10,00
- motivo: `formas_confirmadas`
- `distribuicao_oficial_alterada`: `false`

Com o formato que o PDV exporta, dinheiro `informada` e `aprovado: false`:

- fiscal: R$ 50,00
- não fiscal: R$ 0,00

`parcelaEfetivamenteConfirmada` descarta `aprovado === false` antes de classificar a forma. O dinheiro deixa a referência. Esse não foi o caminho da nota 1022, porque a porta estava fechada. É uma condição que distorce a referência se a porta for ligada na avaliação do PDV.

## 5. Itens recebidos pela composição

O serviço de documento, com a porta fechada, recebe os três itens comerciais e devolve antes da composição:

- código: `ambiente_teste_desligado`
- `bloqueado`: `false`
- `aplicavel`: `false`
- XML: `null`
- itens fiscais: nenhum

`bloqueado: false` aqui significa “não apliquei e não impeço o fechamento”. O PDV, ao ler `documento_fiscal.bloqueado`, não segura a venda.

Com a porta ligada e categoria `PASTEIS` no pastel de R$ 16,92, o residual fiscal seria R$ 33,08 (50,00 − 16,92). Sem modelos, `buscarComposicao` devolve composição ausente. O serviço para em `COMPOSICAO_AUSENTE_NO_MOTOR`. Não inventa refrigerante e não chama o distribuidor. XML: `null`.

Sem categoria `PASTEIS`, o código é `SEM_PASTEL_ELEGIVEL`. Também não há XML.

Com `aprovado: false` no dinheiro, o código é `PAGAMENTO_INCOMPLETO` e a composição nem começa.

A quantidade fiscal de cada refrigerante da nota real não foi calculada. O motor não chegou a uma composição autorizada neste ambiente, e o cadastro real não foi consultado.

## 6. Distribuidor

O distribuidor que rodou para a forma do XML 1022 foi o exclusivo, com `vendaFiscal === true`:

| Item | Quantidade | Quantidade fiscal | Valor fiscal | Valor não fiscal |
|---|---:|---:|---:|---:|
| Pastel do Cheff | 2 | 2 | 16,92 | 0,00 |
| Refrigerante Copo 200 ml | 2 | 2 | 24,45 | 0,00 |
| Refrigerante Copo 300 ml | 1 | 1 | 18,63 | 0,00 |
| Total | | | 60,00 | 0,00 |

`encaminharPropostaValidadaAoDistribuidorOficial` não foi executado. Sem `CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR` e sem harness, a autorização interna continua ausente. Se a composição tivesse sido encontrada, o próximo código seria `AUTORIZACAO_AUSENTE`, ainda sem XML da Sprint 28.

## 7. Lista entregue ao emissor

Com a porta fechada, `emitirPorVendaId` entrega a `buildNfceXml` a lista filtrada de `vendas_itens`: as três linhas com valor fiscal 16,92, 24,45 e 18,63. Não há segunda lista.

`itensDanfe` continua sendo a lista original carregada da venda. O DANFE e o XML usam a mesma origem comercial fiscalizada por inteiro.

## 8. Origem dos R$ 60,00

Origem dos itens: carrinho comercial persistido por `inserirItensDaVenda`, depois de `distribuirItensVendaComValorFiscalEfetivo` no bucket fiscal.

Origem dos pagamentos: parcelas sequenciais sem `tipo_recebimento`. `resolverPagamentosNfce` inclui todas. O dinheiro de R$ 10,00 entra como `tPag=01` e soma em `vPag`.

`vProd`, `vNF` e `vPag` fecham em 60,00 porque itens e pagamentos descrevem a venda comercial inteira. A referência de R$ 50,00 não foi um argumento de `buildNfceXml`.

## 9. Evidência

Comando, fora do repositório, com `DB_DIR` temporário definido antes de carregar `backend/database.js`:

`node C:\Users\cicer\AppData\Local\Temp\cds-aud30-rastreio.js`

Saída relevante, correlação `AUD30-NFCE-1022`:

- banco oficial: `false`
- porta do emissor: `false`
- referência desligada: fiscal `null`, não fiscal `null`
- documento desligado: `ambiente_teste_desligado`, XML `null`
- motor exclusivo: valor fiscal `60`, valor não fiscal `0`
- XML reproduzido: `vProd` 60, `vNF` 60, `vPag` 60, `tPag` 17, 04, 03, 01
- referência com a porta ligada na chamada: 50 e 10, sem alterar a distribuição
- sem modelo: `COMPOSICAO_AUSENTE_NO_MOTOR`
- sem categoria `PASTEIS`: `SEM_PASTEL_ELEGIVEL`
- dinheiro com `aprovado: false`: `PAGAMENTO_INCOMPLETO`

Log do construtor na reprodução: `ICMSTOT MODELO: MODELO_LIQUIDO { vProd: 60, vDesc: 0, vNF: 60, vTroco: 0, somaItens: 60 }`.

## 10. Menor correção necessária

Não implementar nesta auditoria. A menor correção que preserva as regras já escritas:

1. Em `backend/services/vendas/VendaPagamentoService.js`, a quantidade e o valor gravados em `vendas_itens` precisam ser os da composição autorizada quando a referência tiver parte não fiscal. Hoje `criarVenda` grava o resultado do distribuidor exclusivo e trata a referência como anexo.
2. Em `backend/services/fiscal/emissor.js`, a troca de itens não pode depender apenas de `CDS_RECOMPOSICAO_REFERENCIA_TESTE` se a NFC-e operacional tiver de respeitar a referência. Sem uma lista fiscal autorizada, o emissor deve recusar com o código real, em vez de emitir o carrinho de R$ 60,00.
3. Em `frontend/pdv/js/pdv.js`, o ramo sequencial precisa marcar o dinheiro com `tipo_recebimento: 'nao_fiscal'` antes do `POST`, e `PagamentoSequencial.exportar` não pode fazer o dinheiro confirmado parecer rejeitado por `aprovado: false`.
4. `PagamentoRecomposicaoDocumentoService.js` já sabe não montar XML quando a composição ou a autorização faltam. Essa recusa precisa chegar ao fechamento. Ligar a variável de teste sozinha, sem modelo e sem autorização do distribuidor, bloqueia a emissão. Não produz o XML de R$ 50,00.
5. Não reduzir `vNF` para 50 mantendo itens que somam 60. Não habilitar `RECOMPOSICAO_HABILITADA_EM_PRODUCAO`.

A quantidade fiscal de cada refrigerante continua dependendo do motor e do saldo da empresa. Isso não deve ser presumido.

## 11. Riscos de regressão

- Sprint 26: a fórmula 50/10 está correta quando a parcela de dinheiro não vem com `aprovado: false`. Mudar essa condição altera a referência calculada no PDV e os testes que exportam a parcela manual.
- Sprint 28: os testes passam a variável e o harness por argumento. O PDV operacional não passa nem um nem outro. Uma correção que passe a bloquear emissão sem composição muda o fechamento que hoje conclui a venda e emite os R$ 60,00.
- Sprint 29: o fechamento já persiste a venda e dispensa a confirmação fiscal extra. Trocar os itens persistidos ou recusar a emissão muda o contrato que a chave `chave_fechamento_pdv` devolve. Uma segunda tentativa não pode criar outra venda.

A categoria real do pastel e os saldos fiscais e não fiscais da empresa da nota 1022 continuam desconhecidos nesta auditoria.
