# MESAS-07 — Paridade mobile com a finalização e o encaminhamento ao PDV

**Status: implementado e validado em navegador mobile contra API simulada. NÃO homologado** (ver Limitações).

## 1. Auditoria (respostas)

1. **Fluxo desktop:** conferência do pedido → "Enviar para preparação" (etapa separada) → `iniciarVendaPdv` (`frontend/erp/js/pedidos.js`): `confirm`, guarda de operações pendentes, `preparar-venda-pdv`, grava `sessionStorage['pdvPedidoHandoff']` e abre `/pdv`.
2. **"Finalizar pedido" no desktop:** `preparar-venda-pdv`; se já existe venda (`venda_id>0`) chama `finalizar-venda-pdv` (recuperação do vínculo, sem navegar); se `venda_concluida`, apenas informa.
3. **`POST /api/pedidos/:id/preparar-venda-pdv`:** empresa vem do contexto autenticado; idempotente (operação existente retorna `recuperacao:true`, com `venda_id`/`venda_concluida`); retorna `pedido_id, empresa_id, operacao_id, itens, total`.
4. **`POST /api/pedidos/:id/finalizar-venda-pdv`** (corpo `{}`): `FaturamentoService.finalizarVendaPdvPedido` vincula a venda ao pedido; `PAGAMENTO_PDV_PENDENTE` se pagamento pendente; `registrarMesaAposVendaConfirmada` só encerra o atendimento quando totalmente quitado.
5. **Preservação do handoff:** `sessionStorage['pdvPedidoHandoff']` com pedido, empresa, `operacao_id`, itens, `sessao_operador_id`.
6. **Recuperação no PDV:** `mobile-pdv.js` lê o handoff, valida operador/empresa, e após `POST /vendas` chama `finalizar-venda-pdv`.
7. **`?mesa=ID` no mobile:** não havia compatibilidade no PDV; o botão de PDV estava oculto em modo mesa.
8. **Venda individual/consolidada:** individual via os endpoints acima; consolidada via `POST /venda-consolidada-mesa` + `/:consolidacaoId/vincular` (somente UI desktop).

## 2. Causa raiz

A MESAS-06 ocultou "Enviar para o PDV" no modo mesa e a conferência mobile não tinha ação de finalizar; `mobile-mesas` não carregava `encaminharPedidoAoPdv`; o PDV mobile não tinha retorno à mesa.

## 3. Contratos reutilizados (sem alteração de backend)

`preparar-venda-pdv`, `finalizar-venda-pdv`, `MobilePedido.encaminharPedidoAoPdv`, handoff `pdvPedidoHandoff`, PDV mobile existente. Nenhuma venda/pagamento é criada no front mobile; nenhum `empresa_id`/`operador_id`/atendimento é enviado como autoridade.

## 4. Correção aplicada

- Conferência da mesa: botão **"Finalizar pedido e ir para o PDV"** (ou "Recuperar operação no PDV" se `venda_id>0`) apenas para pedido enviado à preparação; modal de confirmação (desabilitado durante o envio → protege duplo toque).
- `finalizarNoPdv`: reconsulta o servidor e bloqueia atendimento encerrado/em fechamento, pedido de outra empresa, FATURADO/CANCELADO/ORCAMENTO e pedido não enviado; só navega com `pedido_id` coincidente e `operacao_id` válido; `VENDA_JA_VINCULADA` → finalizar (sem navegar); `VENDA_JA_CONCLUIDA` → somente consulta; falha de rede → mensagem, sem navegar.
- Dica de retorno `cdsMesaRetorno` (`{mesa_id, pedido_id, empresa}`) validada no PDV (`destinoRetornoMesa`) → links "Voltar à mesa".
- O atendimento nunca é encerrado pelo cliente.

## 5. Arquivos alterados

- `frontend/mobile-mesas/mobile-mesas.js`, `index.html`, `mobile-mesas.css`
- `frontend/mobile-pdv/mobile-pdv.js`, `index.html`
- `tests/mobile-mesas/mobile-mesas-07.test.js` (novo, 19 testes)

## 6. Testes automatizados

| # | Cenário | Resultado |
|---|---|---|
| 1 | Pedido enviado → PDV | OK |
| 2 | Falha na preparação sem navegar | OK |
| 3 | Duplo toque | OK |
| 4 | Perda de conexão no handoff | OK |
| 5 | Refresh após encaminhamento | OK |
| 6 | Recuperação de operação existente (mesmo `operacao_id`) | OK |
| 7 | Pedido de outra empresa | OK |
| 8 | Atendimento encerrado/em fechamento | OK |
| 9 | Faturado/cancelado | OK |
| 10 | Dois pedidos na mesma mesa | OK |
| 11 | Venda individual | OK |
| 12 | Venda consolidada | Limitação (desktop apenas; informado na tela) |
| 13 | Retorno do PDV à mesa | OK |
| 14 | Preservação de dados/estado do atendimento | OK |

Regressões: `mobile-mesas`, `mobile-pedido`, `mobile-pdv`, `erp/mesas-0*`, `mesas-05*`: **168/168**. Contratos de handoff/PDV/venda: 38/39; a falha (`sprint35-pedidos-ui`, regex do menu do ERP) é pré-existente e não relacionada. `tests/pedidos/mesas-02/03/04` falham com `no such table: clientes` (pré-existente, documentado na MESAS-06).

## 7. Evidências de validação visual (navegador, viewport mobile, API simulada)

- Conferência do pedido 503 exibe o botão; modal abre, botões de 52 px, sem rolagem horizontal.
- Duplo clique em "Confirmar": 1 preparo, 1 operação; abre `/mobile-pdv` com pedido #503, itens, total R$ 16,00 e link "Voltar à mesa".
- Refresh no PDV preserva o handoff; "Voltar à mesa" → `/mobile-mesas/?mesa=2`, mesa continua Ocupada, atendimento inalterado, pedidos 503/504 preservados.
- Falha de preparação: mensagem, sem navegação, sem handoff novo.
- Offline: "Sem conexão… o PDV não foi aberto"; ao restaurar, segue ao PDV com `recuperacao:true` e a mesma `operacao_id` (71).
- Venda existente + pagamento pendente: finalizar chamado, mensagem de pagamento pendente, sem navegar.

## 8. Limitações

- **Não homologado:** a validação foi contra API simulada (harness local) e testes automatizados; não houve validação contra backend real de homologação (exige licença/autenticação e banco isolado) nem em aparelho físico.
- Venda consolidada não implementada no mobile (exigiria `consolidacao_id` no PDV mobile e no montador de fechamento, tocando o motor de venda); permanece apenas no computador.
- Pagamento no PDV mobile não foi simulado; validado até a abertura do PDV e o handoff.
- Retorno do PDV à mesa depende de `sessionStorage` (perdido ao fechar a aba).
