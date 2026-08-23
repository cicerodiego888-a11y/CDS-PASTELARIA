# Sprint 05.10 — Estabilização operacional do PDV Universal

## Objetivo

Centralizar a **sessão visual** do PDV Universal. A verdade do domínio continua em venda, atendimento, reserva, pagamento, materialização e fiscalização.

Não cria motor, checkout, pagamento, reserva, endpoint financeiro nem fallback entre EMPRESA_UNICA e MULTIEMPRESA.

## Camada

`frontend/pdv-universal/pdv-universal-session.js` (`PdvUniversalSession`)

Responsabilidades: estado visual, locks, último estado seguro, reset, recuperação após erro.

Fora desta camada: cálculo financeiro, estoque, rateio, regra fiscal.

## Estados visuais

| Estado | Uso |
| --- | --- |
| INICIAL | Sessão limpa |
| CARRINHO_ATIVO | Itens no atendimento visual |
| CHECKOUT_PROCESSANDO | FINALIZAR em voo |
| ATENDIMENTO_VALIDADO | MULTIEMPRESA após checkout |
| RESERVA_PROCESSANDO | Reserva em voo |
| ATENDIMENTO_RESERVADO | Reserva concluída |
| PAGAMENTO_PROCESSANDO | Pagamento em voo |
| ATENDIMENTO_PAGO | Pagamento confirmado |
| MATERIALIZACAO_PROCESSANDO | Materialização em voo |
| FISCALIZACAO_PROCESSANDO | Fiscalização em voo |
| COMPROVANTE_DISPONIVEL | Preview/impressão disponível |
| ERRO_RECUPERAVEL | Falha; último estado seguro preservado |

## Último estado seguro (erro)

| Ação | Volta para |
| --- | --- |
| CHECKOUT | CARRINHO_ATIVO (carrinho mantido) |
| RESERVAR | ATENDIMENTO_VALIDADO |
| PAGAR | ATENDIMENTO_RESERVADO (não cobra de novo) |
| MATERIALIZAR | ATENDIMENTO_PAGO (não cobra de novo) |
| FISCALIZAR | ATENDIMENTO_PAGO + comprovante conforme contrato |

Erro nunca limpa carrinho, não recria atendimento e não troca empresa dos itens.

## Locks

`adquirir(sessao, acao)` recusa se `lock` já estiver ocupado. Atalhos (F1, ENTER, ESC) ficam bloqueados durante processamento. ESC nunca cancela operação financeira: só fecha modal.

## Cancelamento MULTIEMPRESA

VALIDADO ou RESERVADO → confirmação → `POST` oficial via `PdvUniversalPagamento.cancelarAtendimento` → MUV libera reservas → reset visual → INICIAL.

O frontend não simula cancelamento nem altera estoque.

## Reset visual

`resetarSessaoPDVUniversal()` limpa carrinho, atendimento da sessão, locks, pagamentos temporários e mensagens. **Não** apaga `cds_empresa_id`, modo operacional, vendas, NFC-e ou reservas persistidas.

Carrinho só some automaticamente em: venda EMPRESA_UNICA ok; NOVO ATENDIMENTO após ciclo MULTIEMPRESA; cancelamento oficial ok.

## Isolamento

EMPRESA_UNICA não reserva/paga/materializa/fiscaliza atendimento. MULTIEMPRESA não cai em `POST /api/vendas`. Fechar modal não altera o domínio.

## PDV legado

`/pdv` e `POST /api/vendas` permanecem intactos.
