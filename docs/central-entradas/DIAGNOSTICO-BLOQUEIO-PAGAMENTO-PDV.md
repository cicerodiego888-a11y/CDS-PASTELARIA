# Diagnóstico — bloqueio de configuração/autorização de pagamento no PDV

A mensagem aparece no PDV antes de qualquer envio da venda. A forma escolhida exige TEF, o TEF está desligado e o modo gravado não abre a confirmação manual. A finalização para no próprio navegador.

Data: 31/10/2026. Nenhum código, banco, configuração ou permissão foi alterado. A finalização não foi repetida. TEF, PIX e emissão fiscal não foram iniciados.

## Causa-raiz

`executarFinalizacaoVenda` em `frontend/pdv/js/pdv.js` chega ao guarda da Etapa E com as quatro condições verdadeiras ao mesmo tempo:

- a forma exige TEF (`cartao`, `cartao_credito`, `cartao_debito`, `credito`, `debito`, `pix`, `pix_tef`, `tef`, ou um misto que contenha uma delas);
- nenhum ramo de pagamento terminou (`ramoPagamentoConcluido` falso);
- o payload não tem `tef_transacao_id`;
- `confirmacao_fiscal_manual` não foi marcada.

Isso ocorre porque `resolverFluxoPagamentoFiscal` devolve `deveUsarTefAutomatico` falso e `usarConfirmacaoManual` falso. O automático só liga com TEF habilitado. O manual só liga com modo `MANUAL` e valor fiscal maior que zero. A configuração persistida é modo `TEF` e TEF desligado. Com uma forma que exige TEF, os dois ramos ficam de fora e o guarda exibe o texto.

## Evidência da mensagem

Função: `executarFinalizacaoVenda`. A notificação está em `frontend/pdv/js/pdv.js`, no `return` anterior a `enviarVenda`. Não há `$.ajax` nem `fetch` nessa linha.

O texto só existe nesse ponto do frontend. O backend tem outra frase, em `OrquestradorPagamento.js`: “Não foi possível confirmar a autorização do pagamento. A venda não foi registrada.” Essa frase só sai se `POST /api/vendas` chegar ao orquestrador. Este clique não chega lá.

## O que roda imediatamente antes

Dentro do `try`, duas leituras decidem o ramo. As duas usam `fetch` com `Authorization` e não enviam `X-Empresa-Id`.

| Consulta | Função | Endpoint | Serviço |
| --- | --- | --- | --- |
| Modo fiscal | `obterModoConfirmacaoFiscal` | `GET /api/configuracoes-avancadas/confirmacao-fiscal` | `configService.getModoConfirmacaoFiscal` em `backend/rotas/configuracoes_avancadas.js` |
| TEF ligado | `obterTefHabilitadoConfig` | `GET /api/tef/fluxo-pdv` | `tefConfigService.obterConfiguracao` em `backend/rotas/tef.js` |

As duas rotas exigem sessão válida. Não exigem SUPER ADMIN nem vínculo de empresa. O servidor não grava o status desses GETs, e o console deste clique não foi copiado. O valor persistido, lido em disco, é o que um GET bem-sucedido devolveria:

- `configuracoes.json`: `modo_confirmacao_fiscal` = `TEF`.
- `tef_configuracao.id` 1: `habilitado` = 0, então `tefHabilitado` falso.

Se um dos GETs não vier `ok`, o frontend substitui pelo mesmo par: modo `TEF` e TEF falso. Falha de rede e configuração gravada levam ao mesmo guarda. Não há `code` de API associado a esta notificação, porque ela não é o corpo de uma resposta.

Antes dessas leituras, `precalcularDistribuicaoFiscalVenda` pode chamar `POST /api/vendas/pre-calcular-distribuicao`. Se essa rota devolver erro, a tela mostra “Erro ao calcular distribuição fiscal.” e não a mensagem deste diagnóstico. O pré-cálculo só lê produtos e saldo. `aplicarSaldosDisponibilidadeVenda` não escreve.

## Classificação

O bloqueio é a validação preventiva da configuração de pagamento da Etapa E. Não é autorização de empresa, de usuário, de caixa nem de terminal. Empresa e licença já tinham deixado o PDV abrir, e uma venda em dinheiro foi gravada minutos antes.

`POST /api/tef/pagar` só é chamado dentro dos ramos que não executaram. `processarPagamentoTEF` não rodou. PIX não foi gerado.

## Persistência

Leitura com SQLite em modo somente leitura. Nada foi gravado por este diagnóstico.

| Registro | Resultado |
| --- | --- |
| Última venda | id 35, `created_at` 2026-10-31 23:27:15, total 50,00, forma `dinheiro`, `status_pagamento` quitada, empresa 1, 3 itens |
| Recebimento da venda 35 | id 34, tipo `nao_fiscal`, valor 50,00 |
| NFC-e da venda 35 | nenhuma |
| Transações TEF | 1 linha, id 1, `pix_tef`, 2026-10-25 04:09:55, `venda_id` nulo. Nenhuma nova |
| Venda posterior à 35 | nenhuma |

A venda 35 é dinheiro. Dinheiro não passa por este guarda. Ela é um fechamento anterior, não o clique que exibiu a mensagem. O clique bloqueado não criou venda, parcela, transação TEF nem nota.

## Correção mínima recomendada

Não remover o guarda. Ele está impedindo cartão ou PIX sem autorização, que é o contrato da Etapa E.

Para fechar essa forma sem pinpad, a configuração precisa de um ramo que hoje não existe para este caso: modo `MANUAL` com confirmação explícita no modal já existente. Esse modal só abre quando o valor fiscal é maior que zero. A venda 35 foi inteira não fiscal. Se o carrinho bloqueado também for não fiscal, mudar só o modo para `MANUAL` não abre o modal e o mesmo guarda continua.

A decisão fica com o Tech Lead: permitir a confirmação manual também no total fiscal zero, ou manter o bloqueio e receber essa venda em dinheiro. Não ligar o TEF real nesta etapa.
