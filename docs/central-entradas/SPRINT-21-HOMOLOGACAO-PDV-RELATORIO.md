# Sprint 21 — Homologação PDV

Etapa A apenas: diagnóstico dos contratos HTTP e dos pontos de integração do fechamento de venda no PDV.

Nenhuma alteração de código. Etapas B, C, D e E não foram executadas. Banco oficial não foi aberto. Não houve TEF, pagamento, emissão fiscal nem consulta à SEFAZ.

Data: 31/10/2026.

## Decisão da etapa

O fechamento que a tela executa está em `executarFinalizacaoVenda` (`frontend/pdv/js/pdv.js`). Os dois fluxos pedidos pela sprint são os ramos já existentes dessa função:

- **Automático:** `deveUsarTefAutomatico` — TEF ligado e a forma de pagamento exige TEF.
- **Manual:** `usarConfirmacaoManual` — configuração `MANUAL`, valor fiscal maior que zero, e o ramo automático não entrou.

Não há um terceiro fechamento paralelo. O rateio comercial continua no Motor F×NF, chamado duas vezes: no pré-cálculo e de novo em `POST /api/vendas`.

## Sequência HTTP do fechamento

| Ordem | Chamada | Quem decide | O que a tela faz com a resposta |
|---|---|---|---|
| 1 | `GET /api/configuracoes-avancadas/confirmacao-fiscal` | `obterModoConfirmacaoFiscal` | `modo_confirmacao_fiscal === 'MANUAL'` escolhe o manual. Qualquer outra resposta, HTTP não ok ou falha de rede vira `TEF` |
| 2 | `GET /api/tef/fluxo-pdv` | `obterTefHabilitadoConfig` | Usa só `tefHabilitado === true`. Falha de rede ou HTTP não ok vira TEF desligado |
| 3 | `POST /api/vendas/pre-calcular-distribuicao` | `precalcularDistribuicaoFiscalVenda` | Com `sucesso` e HTTP ok, a tela usa `valor_fiscal` e `valor_nao_fiscal`. Falha cai no cálculo local |
| 4 | `POST /api/tef/pagar` | só no ramo automático | Exige `aprovado`, `sucesso` ou `status === 'aprovado'`. HTTP 409 `TRANSACAO_DUPLICADA` reaproveita a transação se ela já estiver aprovada |
| 5 | Modal local, sem HTTP | só no ramo manual | Confirmar segue. Cancelar interrompe e não chama `POST /api/vendas` |
| 6 | `POST /api/vendas` | `enviarVenda` | Sucesso exige `venda_id`, `id`, `vendaId` ou `venda.id`. `status_pagamento === 'aguardando_nao_fiscal'` abre a segunda etapa não fiscal |

Cabeçalhos: pré-cálculo e `POST /api/vendas` enviam `Authorization` e, quando há empresa selecionada, `X-Empresa-Id`. As duas consultas de modo (passos 1 e 2) enviam só o token. `POST /api/tef/pagar` envia o token e o corpo `{ tipo, valor, parcelas, venda_id, idempotency_key }`.

`POST /api/vendas` ainda recebe os dados do terminal (`getTerminalRequestData`) e, se existir, `selecao_hash`. O comentário no cliente registra que o servidor recalcula a empresa e prevalece sobre o header.

## Contratos

### Pré-cálculo — `preCalcularDistribuicao`

Entrada usada pela tela: `itens`, `emitir_fiscal`, `pagamentos`, `desconto`, `acrescimo`.

Saída de sucesso:

- `sucesso: true`
- `liquido_aplicado_backend: true`
- `valor_fiscal`, `valor_nao_fiscal`
- `valor_fiscal_maximo`, `valor_fiscal_efetivo`, `valor_fiscal_liquido`, `valor_nao_fiscal_liquido`, `valor_fiscal_bruto`
- `midp_preservacao`, `liquido_comercial`
- `itens[]` com `produto_id`, quantidades e valores fiscal e não fiscal

Erro de validação: HTTP 400, `{ sucesso: false, error }`. Estoque da empresa com falha: HTTP 500.

A tela, quando `liquido_aplicado_backend` vem verdadeiro, não reaplica o rateio local. O rateio local (`aplicarDescontoProporcionalDistribuicao`) só roda se o pré-cálculo remoto falhar. Esse espelho está documentado como cópia de `valorFiscalLiquido.js`.

### Fechamento — `criarVenda`

`body.valor_fiscal` e `body.valor_nao_fiscal` são ignorados. O comentário no serviço marca o Motor como fonte do valor persistido. A tela pode mostrar o pré-cálculo; a gravação usa o recálculo de `criarVenda`.

Persistência em `vendas`: `total` comercial, `desconto`, `valor_fiscal`, `valor_nao_fiscal`, `status_pagamento`, `empresa_id`, caixa e terminal. Itens e recebimentos entram na mesma transação.

Resposta de sucesso (`responderVendaComFiscal`):

- `id`, `venda_id`, `codigo`, `message`
- `status_pagamento`, `valor_fiscal`, `valor_nao_fiscal`
- `fiscal: null` quando a venda não pede emissão, ou quando o valor fiscal é zero

`emitir_fiscal: true` com pagamento quitado chama `emitirPorVendaId`. Isso é emissão fiscal. A homologação não pode usar esse corpo.

Erros que a tela já trata em `POST /api/vendas`:

- HTTP 409 com `pode_continuar`: modal de débito e reenvio com `forcar: true`
- timeout: avisa para conferir o histórico antes de tentar de novo
- rede (`status === 0`): mensagem de falha de rede e libera a trava
- corpo com `code` de empresa, seleção, matriz, caixa ou tipo de saldo: banner na tela
- demais: `mensagem` ou `error`

### Ramo automático

`resolverFluxoPagamentoFiscal` existe em dois arquivos que precisam permanecer iguais:

- `frontend/shared/js/tefFluxoPagamento.js`
- `backend/services/tef/tefFluxoPagamento.js`

`deveUsarTefAutomatico` é verdadeiro só com TEF habilitado e forma que exige TEF (`cartao`, crédito, débito, `pix`, `pix_tef`, `tef`).

A tela então chama `POST /api/tef/pagar` antes de `POST /api/vendas`, grava `dados.tef` e marca `pagamentos_processados_pdv` quando o total fiscal é positivo e o não fiscal é zero. O backend, com pagamentos já processados, não pede outra autorização TEF (`devePularAutorizacaoTefBackend`).

Trava de duplicidade nesse ramo: `window.__tefPagamentoEmAndamento` e `idempotency_key`. HTTP 409 `TRANSACAO_DUPLICADA` com transação já aprovada devolve a mesma transação em vez de cobrar de novo.

### Ramo manual

Entra quando o modo global é `MANUAL`, o valor fiscal é maior que zero e o automático não assumiu.

A tela abre `#confirmar-recebimento-fiscal-manual`. Não há HTTP nessa confirmação. Confirmado, o payload segue com `confirmacao_fiscal_manual: true` e pagamentos sem NSU de TEF. Cancelado, `vendaEmProcessamento` volta a falso e `POST /api/vendas` não ocorre.

No backend, `isConfirmacaoFiscalManualFlag` aceita a flag do corpo ou o modo global `MANUAL`. Com TEF desligado, a autorização TEF é pulada.

### Caminho que não é nenhum dos dois

Se a consulta do modo falha, a tela assume `TEF`. Se a consulta do TEF falha, a tela assume TEF desligado. As duas falhas juntas deixam `deveUsarTefAutomatico` e `usarConfirmacaoManual` falsos. A função não entra em ramo nenhum e ainda chama `POST /api/vendas` com os pagamentos originais. Esse é o ponto de tratamento HTTP a provar na etapa seguinte, sem alterar a regra nesta etapa.

## O que a interface mostra

Sucesso de `POST /api/vendas`: notificação “Venda finalizada com sucesso.”, cupom não fiscal quando a venda está quitada e não emite fiscal, e limpeza do carrinho em `finalizarPosVenda`.

`status_pagamento === 'aguardando_nao_fiscal'` não mostra esse sucesso final. Abre `iniciarFluxoPosVendaComNaoFiscal` e depois `POST /api/vendas/:id/pagamento-nao-fiscal`.

Resposta sem id de venda mostra erro e não limpa o carrinho. `vendaEmProcessamento` impede um segundo clique enquanto o primeiro fechamento não termina. Timeout não reenvia sozinho.

## Rateio que a homologação precisa preservar

O pré-cálculo e o `POST /api/vendas` chamam `distribuirItensVendaComValorFiscalEfetivo` com os mesmos `pagamentos`, `desconto` e `acrescimo`. A política MPFC entra por `carregarPoliticaFiscalComercialPassiva`. A tela não substitui esse resultado quando o pré-cálculo remoto responde `liquido_aplicado_backend: true`.

O valor gravado em `vendas.valor_fiscal` é o do recálculo do `criarVenda`, não o número que a tela colocou no corpo.

## Isolamento exigido para a Etapa B

`VendaPagamentoService.js` carrega `backend/database.js` no topo do arquivo. Qualquer teste que importe esse serviço abre o banco configurado no processo. A Etapa B só pode importá-lo depois de um `DB_DIR` temporário, fora de `C:\ProgramData\MercantilFiscal\dados\mercadao.db`.

O ramo automático, do jeito que a tela está, chama `POST /api/tef/pagar`. A homologação não pode executar esse endpoint real. O ramo a provar é o contrato e o tratamento da resposta, com TEF substituído.

`emitir_fiscal: true` no fechamento dispara NFC-e. A homologação permanece com emissão desligada.

Há um segundo par automático/manual dentro de `criarVenda`: `EmpresaModoEstoqueService` decide a baixa de estoque (`AUTOMATICO` ou `MANUAL`). Isso não escolhe o ramo da tela. A tela não lê esse modo no fechamento. Fica registrado para não misturar com o fluxo TEF/manual desta sprint.

## O que não foi feito

Etapa B (automático ponta a ponta), Etapa C (manual ponta a ponta), Etapa D (interface, persistência e consistência) e Etapa E (correção) não começaram. Nenhum arquivo de produção foi alterado nesta etapa.
