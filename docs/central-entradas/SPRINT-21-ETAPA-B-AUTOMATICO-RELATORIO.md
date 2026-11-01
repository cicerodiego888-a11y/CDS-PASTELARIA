# Sprint 21 — Etapa B: homologação do fluxo automático

Homologação do fechamento automático do PDV em banco SQLite temporário, com o contrato TEF simulado. Etapas C, D e E não foram executadas. Nenhum arquivo de produção foi alterado.

Data: 31/10/2026.

Suíte: `node --test --test-concurrency=1 tests/pdv/sprint-21-etapa-b-automatico.test.js` — 8 testes, 8 aprovações de execução. O critério de segurança da falha simultânea das configurações ficou reprovado; o teste registra esse resultado.

## Isolamento

- Banco comprovado: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21b-1bsSut\mercadao.db`
- O caminho não contém `ProgramData\MercantilFiscal`.
- `DB_DIR` foi definido antes de carregar `backend/database.js`.
- `tefManager.autorizar` foi substituído por uma trava que lança `TEF_REAL_BLOQUEADO`. Contagem de chamadas nessa trava: **0**.
- `emitirPorVendaId` foi substituído antes do carregamento do serviço de venda. Contagem de emissões: **0**.
- Toda gravação saiu com `emitir_fiscal: false`. A tela, quando o operador pede emissão, ainda monta `emitir_fiscal: true`. O teste troca essa flag para `false` e envia `venda_fiscal: true`, para o Motor continuar no bucket fiscal sem NFC-e. A função de NFC-e da tela foi interceptada e não consultou a SEFAZ.
- A leitura da configuração copiou o JSON para a pasta temporária do teste. O destino registrado foi `...\cds-sprint21b-1bsSut\config\configuracoes.json`.

## Cenários

| Cenário | Esperado | Obtido | Resultado |
|---|---|---|---|
| B1 aprovação | TEF mock antes de `POST /api/vendas`, venda gravada com NSU e autorização, carrinho limpo | Uma chamada a `POST /api/tef/pagar`, depois uma a `POST /api/vendas`. Venda 1, empresa A, total 10, `valor_fiscal` 10, `valor_nao_fiscal` 0, `status_pagamento` quitada. Notificação “Venda finalizada com sucesso.” | Aprovado |
| B2 recusa | Sem `POST /api/vendas`, carrinho preservado, erro na tela | HTTP de recusa. Mensagens: “Pagamento recusado pelo mock” e “Pagamento fiscal não aprovado.” Carrinho com 1 item. Nenhuma venda nova | Aprovado |
| B3 duplicidade | Reaproveitar a transação aprovada, sem segunda autorização | O mock de HTTP 409 devolveu a transação 2 já aprovada. A venda gravou esse id e o NSU anterior. `iniciarPagamento` não foi chamado de novo. Pela rota real, duplicata aprovada responde **200** com `codigo: TRANSACAO_DUPLICADA`; duplicata sem aprovação responde **409** | Aprovado |
| B4 duplo clique | Uma autorização e uma venda | Duas entradas simultâneas. A segunda passou da checagem inicial de `vendaEmProcessamento` e parou em `window.__tefPagamentoEmAndamento` (“Já existe um pagamento TEF em andamento.”). Uma autorização mock e uma venda | Aprovado |
| B5 timeout e rede | Falha não vira aprovação e não grava venda | Contrato `TIMEOUT` (sucesso falso), erro 500 do mock e `TypeError: Failed to fetch`. Nenhum `POST /api/vendas`. Carrinho preservado. O `fetch` de `/tef/pagar` não define timeout | Aprovado |
| B6 rateio | Pré-cálculo e gravação coincidem; o corpo não manda no valor | Desconto 1 e acréscimo 0,50. Total 9,50, `valor_fiscal` 9,50, `valor_nao_fiscal` 0. Reenvio com `valor_fiscal: 999` gravou de novo 9,50 | Aprovado |
| B7 empresa | Empresa autorizada; header ou body de empresa não autorizada não grava | Operador vinculado só à empresa A. Header da empresa B: HTTP 403 `EMPRESA_NAO_AUTORIZADA`. Body com a empresa B, sem header: 403. Header A com `empresa_id` B no corpo: venda na empresa A. Nenhuma venda na empresa B | Aprovado |
| Falha das duas consultas | Não fechar cartão sem autorização | `GET` de confirmação e `GET` do fluxo TEF responderam 503. A tela não chamou `/tef/pagar` e chamou `POST /api/vendas` com o cartão original, sem NSU e sem `confirmacao_fiscal_manual`. A venda foi gravada, o carrinho foi limpo e a tela mostrou “Venda finalizada com sucesso.” | Reprovado |

## Ordem das chamadas no B1

1. `POST /api/vendas/pre-calcular-distribuicao` — a função real espera esse retorno antes de escolher o ramo.
2. `GET /api/configuracoes-avancadas/confirmacao-fiscal` — modo `TEF`.
3. `GET /api/tef/fluxo-pdv` — `tefHabilitado: true`.
4. `POST /api/tef/pagar` — mock aprovado, linha em `tef_transacoes` no banco temporário, sem adquirente.
5. `POST /api/vendas` — pagamentos com `tef_transacao_id`, `nsu` e `autorizacao`, e `pagamentos_processados_pdv: true`.

O teste comprovou que o índice da chamada TEF é anterior ao de `POST /api/vendas`. `tefManager.autorizar` não rodou: o orquestrador encontrou `tef_transacao_id` e não pediu outra autorização.

## Persistência no banco temporário

Venda aprovada do B1: `valor_fiscal` 10 e `valor_nao_fiscal` 0, iguais ao valor que a tela colocou no corpo a partir do pré-cálculo. `venda_recebimentos` guardou o mesmo NSU e o mesmo `tef_transacao_id`.

Venda do B6: total 9,50 e `valor_fiscal` 9,50, com desconto 1. O segundo `POST /api/vendas`, com `valor_fiscal` e `valor_nao_fiscal` forçados para 999, persistiu outra vez 9,50 e 0. O Motor recalcula; o número do corpo não é a fonte.

## Timeout, recusa e duplicidade

- Recusa: o mock responde sucesso falso e status `negado`. A tela trata como não aprovado e não chama `POST /api/vendas`.
- Timeout: o mock responde `codigo: TIMEOUT`, sucesso falso. `estaAprovado` é falso. A rota devolve HTTP 422. A venda não é gravada.
- Rede: exceção no `iniciarPagamento` vira HTTP 500; queda do `fetch` cai no `catch` de `processarPagamentoTEF` e devolve `null`. Nos dois casos a trava `__tefPagamentoEmAndamento` é liberada e o carrinho permanece.
- Duplicidade aprovada na rota real: HTTP 200, não 409. O cliente aceita porque `aprovado` é verdadeiro e reutiliza a mesma transação. O ramo do cliente que trata HTTP 409 com transação já aprovada também foi exercido por resposta simulada e reaproveitou o id 2 sem nova autorização.
- Duplicidade sem aprovação na rota real: HTTP 409 `TRANSACAO_DUPLICADA`.

## Falha simultânea das configurações

Causa, no código atual de `executarFinalizacaoVenda`:

- `obterModoConfirmacaoFiscal` devolve `TEF` quando o HTTP não está ok ou a rede falha.
- `obterTefHabilitadoConfig` devolve `false` nas mesmas condições.
- Com TEF desligado, `deveUsarTefAutomatico` e `usarConfirmacaoManual` ficam falsos.
- A função não retorna. Segue para `enviarVenda` com o pagamento original do cartão.
- No backend, com TEF desligado, `deveUsarTEFParaFiscal` é falso e o orquestrador confirma o recebimento fiscal no caminho manual, sem exigir a flag `confirmacao_fiscal_manual` nem um `tef_transacao_id`.

Efeito observado nesta etapa: venda nova, sem TEF, carrinho vazio, mensagem de sucesso. Não houve autorização no mock nem chamada à trava do adquirente.

Correção proposta, não aplicada:

Depois do `try` que escolhe o ramo, e antes de `enviarVenda`, interromper quando a forma exige TEF e o payload não tem `dados.tef` nem `dados.confirmacao_fiscal_manual`. Liberar `vendaEmProcessamento`, mostrar erro e retornar. `pagamentoExigeTef` hoje nasce dentro do `try`; a correção precisa guardá-lo fora desse bloco. Isso impede o `POST /api/vendas` nesse caso, sem criar outro fechamento e sem mudar o rateio.

## Arquivos

- Criado: `tests/pdv/sprint-21-etapa-b-automatico.test.js`
- Criado: este relatório
- Produção: nenhum arquivo alterado

## O que não foi feito

Etapa C (manual), Etapa D (interface e persistência em conjunto) e Etapa E (correções) não começaram. A correção da falha simultânea das configurações fica para avaliação antes de qualquer alteração de produção.
