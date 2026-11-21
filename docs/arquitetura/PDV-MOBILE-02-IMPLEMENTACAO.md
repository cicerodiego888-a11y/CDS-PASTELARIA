# PDV-MOBILE-02 — Venda mobile com pagamento sequencial

A tela do celular encaminha o pedido e fecha a venda pelo mesmo contrato do PDV do computador. Não há segundo núcleo de preço, estoque, pagamento ou NFC-e.

Esta entrega não é homologação no aparelho. PIX, débito e crédito continuam dependendo da estação que tem o pinpad.

## Arquivos

Criados:

- `frontend/mobile-pdv/index.html`
- `frontend/mobile-pdv/mobile-pdv.css`
- `frontend/mobile-pdv/mobile-pdv.js`
- `frontend/pdv/js/pdv-fechamento-oficial.js`
- `tests/mobile-pdv/pdv-mobile-02.test.js`

Alterados:

- `backend/server.js` — `GET /mobile-pdv`.
- `frontend/shared/js/pdv-acesso-oficial.js` — `/mobile-pdv` no retorno seguro do login.
- `frontend/mobile-pedido/index.html` e `mobile-pedido.js` — botão **Enviar para o PDV**.
- `frontend/shared/js/tefFluxoPagamento.js` — `montarParcelasListaSequencial`, a mesma montagem que o PDV já fazia no ramo `lista_sequencial`.
- `frontend/pdv/js/pdv.js` — o fechamento desktop passa a chamar essa função. O corpo da parcela não mudou.

Não foram alterados `VendaApplicationService`, `VendaPagamentoService`, o motor de recomposição, o estoque, o emissor nem o PDV Universal.

## Encaminhamento do pedido

Na confirmação de `/mobile-pedido`, **Enviar para o PDV**:

1. `POST /api/pedidos/:id/preparar-venda-pdv` com o token e `X-Empresa-Id`.
2. Confere `empresa_id` da composição com a empresa da sessão.
3. Se o pedido já tem venda concluída ou `venda_id`, avisa e não abre outro fechamento.
4. Grava o JSON oficial em `sessionStorage.pdvPedidoHandoff`.
5. Abre `/mobile-pdv` na mesma aba.

Pedido cancelado continua sendo recusado por `prepararOperacaoPdv`. Preparar de novo reutiliza a mesma operação. O carrinho digitado no pedido não substitui o snapshot.

## Identidade e caixa por instalação Mobile

Cada instalação gera um UUID v4 com Web Crypto e o persiste em `localStorage` (`cds_mobile_installation_id_v1`). A identidade identifica a instalação, mas não autentica o operador; o registro e o heartbeat usam o JWT da sessão e a empresa autorizada.

- `POST /api/terminais/mobile/registro` registra ou recupera idempotentemente o terminal Mobile. Registro não cria caixa.
- `POST /api/terminais/mobile/heartbeat` atualiza somente a última conexão. O intervalo do cliente é de dois minutos; a presença do servidor continua considerando online uma conexão recente por menos de três minutos.
- A ação explícita **Abrir meu caixa** fica na área **Meu Caixa**, cria uma configuração exclusiva via `POST /api/terminais/mobile/caixa-config` e depois abre a sessão pelo fluxo oficial `POST /api/caixa/abrir`. `GET /api/caixa/aberto` recupera a sessão existente; a área consulta o saldo oficial e `GET /api/caixa/movimentacoes/:caixa_id`. O fechamento segue `POST /api/caixa/fechar` e a conferência oficial.
- A tela principal do PDV mostra apenas o terminal, o estado e o número da sessão/caixa. Navegar entre PDV e **Meu Caixa** só alterna a tela; não abre, fecha nem modifica a sessão.
- O Mobile não reutiliza nem reassocia o caixa de outro terminal. A validação de identidade também protege chamadas de vendas e caixa; os cadastros genéricos não podem converter um desktop em Mobile nem mover o caixa de um Mobile.
- Contexto de unidade atual: é determinado somente para a Cozinha/KDS. `POST /api/cozinha/sessao/unidade` usa `CozinhaSessaoUnidadeService.selecionarUnidadeSessao`, valida com `cozinhaAuthUnidade.validarUnidadeCozinhaNoLogin` e emite o JWT com `unidade_cozinha_id`; `cozinhaUnidadeOperacional.resolverUnidadeOperacionalReq` considera essa claim autoritativa e rejeita `unidade_id` divergente. As rotas de `cozinha.js` consomem esse resolver.
- O PDV e o Caixa não têm contexto de unidade equivalente: `terminais` e `caixa_sessoes` não registram unidade, e os fluxos protegidos Mobile validam sessão, terminal e empresa. Não foi criado nem inferido vínculo de unidade nesta entrega.
- Para uma futura unidade de PDV, será necessário decidir primeiro se ela é a unidade de cozinha existente ou outro conceito. Depois, o contexto precisará ser validado no registro/heartbeat do `TerminalPdvMobileService`, no `validarTerminalMobile`, nas rotas de vendas e de caixa e na persistência/consulta das sessões em `caixa_sessoes`; nenhuma dessas adaptações foi feita nesta homologação.

## Fechamento

`/mobile-pdv` mostra empresa, operador da sessão, pedido, itens e total do snapshot. O desconto do snapshot não é editado. A abertura, o saldo, as movimentações, o valor contado e o fechamento ficam somente em **Meu Caixa**.

Após a venda ser registrada, a tela exibe somente o resumo da venda e oculta o painel de terminal/caixa. O botão **Continuar para o PDV** recarrega a rota, preservando a identidade local; o Mobile consulta novamente a sessão aberta. Essa navegação não chama o fechamento de caixa nem repete a venda registrada.

O resumo fiscal usa `fiscal`, `documento_fiscal`, `valor_fiscal` e `emitir_fiscal` do retorno/contrato da venda. Estados como `autorizada`, `rejeitada`, `xml_preparado`, `pendente` e falhas de emissão/transmissão são apresentados sem inferir autorização. O contrato atual de `POST /api/vendas` não retorna `total`; por isso o valor total só aparece quando o próprio retorno da venda o fornecer.

O pagamento usa `PagamentoSequencial` e `InteracaoPagamentoMisto`, os mesmos do computador. A ordem das parcelas é a ordem em que foram confirmadas.

- Dinheiro entra como parcela `informada`, confirmação manual, recebimento não fiscal.
- Com TEF ligado, PIX, débito e crédito exigem retorno aprovado e `tef_transacao_id`. Com TEF desligado, são informados sem cobrança e exigem confirmação operacional explícita no fechamento.
- Com dinheiro e a soma fechada, a tela chama `POST /api/vendas/composicao-sequencial`. A recomposição, a tolerância de 20% e o arredondamento saem desse serviço. A tela não recalcula.
- A distribuição sai de `POST /api/vendas/pre-calcular-distribuicao`. Se essa chamada falha, a venda não é enviada.
- A gravação é `POST /api/vendas`, com `origem: PDV`, `chave_fechamento_pdv`, `pedido_id`, `pedido_faturamento_operacao_id` e `pagamento_sequencial: true`.
- As parcelas do corpo são as de `montarParcelasListaSequencial`, a mesma função do `executarFinalizacaoVenda`.
- Depois da venda, `POST /api/pedidos/:id/finalizar-venda-pdv`.
- Segundo clique e venda já persistida não geram outra venda. Sem caixa aberto, o servidor recusa e a tela mostra o erro.

Venda avulsa, sem pedido, pesquisa em `GET /api/produtos/consulta-pdv/buscar` e usa o preço promocional ou `preco_venda` devolvido pela API. Não usa o motor de atacado nem a etiqueta de balança do PDV desktop.

## Igualdade com o computador

Para a mesma lista de parcelas já confirmadas, o JSON de `pagamentos` do celular é o retorno de `montarParcelasListaSequencial`. O PDV desktop, no ramo sequencial, grava essa mesma lista. A classificação fiscal ou não fiscal de cada parcela e a recomposição continuam no servidor, quando a tela pede `composicao-sequencial` e `pre-calcular-distribuicao`.

A ordem PIX depois de dinheiro, ou dinheiro depois de PIX, é preservada no corpo. O resultado da recomposição não é recalculado na página.

## TEF e NFC-e

O mobile consulta a configuração antes de registrar eletrônicos e novamente no fechamento. Com TEF desligado e PIX automático inativo, o operador confirma cada valor PIX em modal próprio com identificação do pedido antes de adicioná-lo; cancelar não registra a parcela. A confirmação final usa o mesmo padrão de modal e exibe modalidades amigáveis, valores individuais e total; cancelar não grava a venda. A interface não usa `window.confirm` ou `window.alert` para confirmações financeiras. Confirmar apenas registra a operação já existente: não inicia cobrança. A ausência da chave de ativação PIX na resposta do serviço equivale a inativo, sem exigir configuração de provedor. Com TEF ligado, o navegador do celular continua acompanhando a estação, sem chamar `POST /api/tef/pagar`. Se o PIX automático estiver ativo, o mobile orienta a usar o desktop, pois não implementa essa integração. Falhas ao consultar a configuração bloqueiam o pagamento.

O Mobile consulta `GET /api/configuracoes/modo_dashboard_fiscal`, protegido pela sessão JWT, assim como o Desktop. Usa esse valor no pré-cálculo oficial `POST /api/vendas/pre-calcular-distribuicao`; no corpo final, `emitir_fiscal` só fica verdadeiro quando o modo está ativo e a distribuição oficial retorna valor fiscal positivo. A configuração fiscal da empresa, certificado e ambiente não são lidos nem replicados no navegador: o serviço oficial resolve esses dados pela empresa persistida na venda.

A gravação `POST /api/vendas` é também o finalizador fiscal: para venda quitada e emissão solicitada, `VendaFiscalService.responderVendaComFiscal` chama `emitirPorVendaId` e devolve o resultado real em `fiscal`. O Mobile não chama em seguida `POST /api/fiscal/emitir/venda/:id`: o finalizador já acionou o serviço oficial e uma segunda tentativa poderia repetir a emissão. O caminho de venda mantém a autenticação, o contexto empresarial, as verificações fiscais e a idempotência já aplicadas ao registro; se a resposta trouxer bloqueio, rejeição, pendência ou falha, o Mobile apresenta o estado sem fabricar autorização.

Antes desta correção, o Mobile enviava `emitir_fiscal: false` tanto no pré-cálculo quanto na gravação; isso classificava a operação no caminho não fiscal e impedia o finalizador de solicitar emissão. Agora o payload segue o modo oficial e o valor fiscal calculado pelo servidor. Nenhuma regra tributária ou serviço fiscal foi duplicado ou alterado.

O incremento de R$ 0,05 do dinheiro permanece no serviço de recomposição já existente. A tela não criou outra regra.

## Testes

`node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-02.test.js tests/mobile-pdv/pdv-mobile-07.test.js tests/mobile-pdv/pdv-mobile-fiscal-01.test.js tests/pdv/pdv-correcao-status-fiscal-handoff-01.test.js`

Resultado: 65 testes passaram. Os testes de integração existentes usam banco temporário e bloqueiam o banco oficial. O teste fiscal novo valida que o finalizador oficial chama `emitirPorVendaId` uma vez apenas para a venda quitada solicitada e devolve o estado stub `pendente`; a camada de emissor e o banco são substituídos por stubs isolados, sem transmissão ou acesso ao banco operacional.

`tests/mobile-pdv/pdv-mobile-03.test.js` foi executado como regressão: permanece uma falha no teste de recomposição “arredonda o dinheiro da nota em R$ 0,05”, que recebe `null` em vez de `fechamento` (`pdv-mobile-03.test.js:289`). A lógica de recomposição não foi alterada nesta entrega.

Identidade e caixa: `node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-07.test.js tests/mobile-pdv/pdv-mobile-08.test.js tests/mobile-pdv/pdv-mobile-09.test.js`. Os testes de registro, autorização, heartbeat e abertura/fechamento usam banco temporário, sem vendas nem banco oficial.

No banco de testes, um pedido `EQUIPE` foi preparado duas vezes na mesma operação, o snapshot conferiu empresa, quantidade e total, o corpo saiu com `origem: PDV` e a chave de fechamento, o pedido cancelado foi recusado na segunda preparação e `vendas` permaneceu em zero.

Em seguida, sem falha:

- `tests/pdv/sprint-25-interacao-sequencial.test.js` — 4
- `tests/vendas/pedido-pdv-composicao.test.js` — 19
- `tests/faturamento/sprint35-pedidos-ui.test.js` — 5

## Reorganização do PDV Mobile e confirmações

O fechamento e a conferência são acessados exclusivamente pela tela **Meu Caixa**; o resumo compacto do PDV não contém campos nem ação de fechamento. O saldo vem do resumo oficial do caixa e as movimentações são consultadas pela rota existente, sem cálculos financeiros locais. A navegação entre telas não chama rotas de abertura ou fechamento.

PIX individual, confirmação final de parcelas externas e confirmação do fechamento usam o modal próprio do CDS. O fluxo final mantém o mesmo serviço de fechamento, idempotência e regra TEF; cancelar a confirmação não envia `POST /api/vendas`. Não há chamada Destaxa nem cobrança iniciada pela interface.

Validação desta reorganização:

- `node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-07.test.js` — 38 testes aprovados.
- Suíte `tests/mobile-pdv/*.test.js` — 106 testes: 104 aprovados e 2 falhas fora do escopo da reorganização: recomposição de moeda em `pdv-mobile-03.test.js:289` e expectativa HTTP 422/409 em `pdv-mobile-05.test.js:250`.
- Navegador em página estática local: 320×568, 375×812 e 430×812; sem overflow horizontal na tela do PDV nem no modal. Essa verificação não exercita o teclado Android nem substitui homologação em aparelho físico.

## Redesign visual do PDV Mobile

`frontend/mobile-pdv/index.html`, `mobile-pdv.css` e `mobile-pdv.js` reorganizam a interface existente, mantendo IDs de integração, eventos, APIs e serviços. A tela segue a referência CDS: cabeçalho institucional compacto, resumo do terminal, operador, busca, destaque para **Venda pelo Valor**, itens, faixa azul-marinho do total, modalidades de pagamento e ação de finalização. O fechamento continua exclusivo da área **Meu Caixa**.

A paleta está centralizada em variáveis CSS. O estado vazio de itens foi compactado; parcelas sem pagamentos e o painel da estação TEF ficam ocultos até serem necessários. Isso não inicia cobrança, altera caixa nem muda a finalização. A identificação do operador também apresenta seu rótulo explicitamente.

Validação visual no navegador local em 320×568, 360×800, 375×812, 390×844 e 430×932: sem rolagem horizontal; botões com altura mínima observada de 44 px. As capturas usam valores de demonstração alterados somente no DOM do navegador, sem chamadas operacionais ou gravações. A página servida estaticamente não tem API disponível (HTTP 404), portanto o estado do terminal e pagamentos não foi integrado nem homologado. A conferência de viewport não reproduz o teclado ou a navegação de um Android real.

`node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-07.test.js tests/mobile-pdv/pdv-mobile-09.test.js`: testes aprovados. Na suíte completa `tests/mobile-pdv/*.test.js`, 104 passaram e 2 falharam nas mesmas verificações já documentadas: recomposição de moeda (`pdv-mobile-03.test.js:289`) e expectativa de status HTTP (`pdv-mobile-05.test.js:250`); nenhuma falha foi introduzida pelo redesign visual.

## Limitações

- Não houve uso manual no celular. O processo do CDS que já estava aberto precisa ser reiniciado para servir `/mobile-pdv`.
- No modo manual, o CDS não verifica o recebimento externo: o operador deve confirmá-lo. No modo TEF, permanece a limitação de execução na estação.
- A emissão fiscal segue o finalizador oficial, mas não houve homologação integrada com certificado nem transmissão de teste à SEFAZ; resultado fiscal real precisa ser homologado em ambiente controlado autorizado.
- A venda avulsa não passa pelo MIP nem pelo preço de atacado do PDV desktop.
- Caixa fechado continua impedindo o `POST /api/vendas`.
- No modo Empresa única, se `pdv_empresa_id` for outra empresa, o snapshot não é carregado.

## Estado

| Estado | Situação |
|---|---|
| CONCLUÍDO | O pedido do celular abre `/mobile-pdv` com o snapshot oficial e o fechamento sequencial usa o `POST /api/vendas` |
| TESTADO | Testes de tela, modo fiscal, payload e acionamento stub do finalizador; nenhum teste transmitiu à SEFAZ |
| HOMOLOGADO | Não. Falta a conferência manual no navegador do celular, com caixa de testes |
| PENDENTE | Homologação fiscal integrada com configuração/certificado de teste e resultado real de autorização, rejeição, pendência e falha de comunicação |
