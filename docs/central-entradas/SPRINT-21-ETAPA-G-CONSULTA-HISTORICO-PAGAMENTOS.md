# Sprint 21G — Consulta e histórico de pagamentos

Correção da recuperação dos pagamentos e recebimentos já gravados. A divergência da Sprint 21D estava na consulta e na tela do histórico, não no fechamento.

Data: 31/10/2026.

As Sprints 21B, 21C, 21E e 21F permanecem homologadas. Esta sprint não alterou o motor F×NF, o orquestrador, a autorização TEF, o vínculo de uso único, o fluxo manual, o fluxo automático nem a emissão fiscal. Nenhuma migration foi executada. O banco oficial não foi aberto. Nenhuma transação real de adquirente, PIX, NFC-e, NF-e ou SEFAZ foi disparada.

## 1. Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `backend/rotas/vendas.js` | `GET /api/vendas` passa a devolver `status_pagamento`, `tef_transacao_id` e `pagamentos_resumo`. `GET /api/vendas/:id` passa a devolver `venda_pagamentos` e `venda_recebimentos`. |
| `frontend/pdv/js/vendas.js` | Lista e modal separam status da venda e status do pagamento, mostram meios, valores, NSU e autorização. |
| `frontend/shared/js/fiscalImpressao.js` | O cupom não fiscal lista as formas persistidas. O total impresso continua o argumento já calculado. |
| `tests/pdv/sprint-21-etapa-g-consulta-historico.test.js` | Cenários 1 a 9 e conferência do cupom, em banco temporário. |

`GET /api/vendas/:id/detalhes` e o caminho de DANFE não foram alterados.

## 2. Contrato de resposta

Os campos novos são aditivos. O objeto da venda, os itens e o `total` comercial permanecem.

`GET /api/vendas/:id`, depois de localizar a venda da empresa do contexto:

- `venda_pagamentos`: `id`, `venda_id`, `forma_pagamento`, `valor`, `tef_transacao_id`, `tef_nsu`, `tef_autorizacao`, `tef_bandeira`, `tef_adquirente`.
- `venda_recebimentos`: `id`, `venda_id`, `tipo_recebimento`, `forma_pagamento`, `valor`, `tef_transacao_id`, `nsu`, `autorizacao`, `status`.

NSU e autorização saem dessas colunas. A consulta não faz join em `tef_transacoes` para preencher o que não estiver gravado na linha.

`GET /api/vendas` inclui, na mesma consulta da lista:

- `status_pagamento`;
- `tef_transacao_id`;
- `pagamentos_resumo`, um `GROUP_CONCAT` de `forma_pagamento|valor` em `venda_pagamentos`.

A lista continua filtrada por `sqlFiltroEmpresaVenda`. A consulta individual continua em `exigirVendaDaEmpresa`. Os pagamentos só são lidos depois que a venda pertence à empresa do contexto.

O total da resposta é `vendas.total`. Pagamentos comerciais e fatias de recebimento são listas separadas e não são somados entre si para formar esse total.

## 3. Histórico e reimpressão

A lista do PDV mostra **Status da venda** (`vendas.status`, por exemplo Concluída) e **Status do pagamento** (`status_pagamento`, por exemplo Quitado). A coluna de forma usa `pagamentos_resumo` e, na ausência dele, a forma do cabeçalho.

O modal mostra a tabela de meios (`forma`, valor, transação TEF, NSU, autorização) e a tabela de recebimentos (`tipo_recebimento`, forma, valor, status, transação, NSU, autorização). O texto da tela informa que esses valores não são somados de novo ao total comercial. O total exibido continua `obterTotalExibicaoHistoricoVenda`, que lê `vendas.total`.

`reimprimirCupomNaoFiscalHistorico` segue buscando `GET /api/vendas/:id`. Com a consulta corrigida, o cupom recebe `venda_pagamentos` e `venda_recebimentos`. Em venda mista, o cupom não fiscal lista só as fatias `nao_fiscal`. Nas demais, lista `venda_pagamentos`. Sem linhas, volta à forma do cabeçalho. A linha `Total` continua `obterTotalCupomNaoFiscal` (`valor_nao_fiscal` quando positivo, senão `total`).

## 4. Testes

`node --test --test-concurrency=1`, um arquivo por vez.

| Suíte | Resultado | Banco temporário |
|---|---|---|
| `tests/pdv/sprint-21-etapa-g-consulta-historico.test.js` | 2/2 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21g-mryDM9\mercadao.db` |
| `tests/pdv/sprint-21-etapa-b-automatico.test.js` (inclui 21E) | 14/14 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21b-opBUBh\mercadao.db` |
| `tests/pdv/sprint-21-etapa-c-manual-interface.test.js` | 7/7 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21c-DvZ3nG\mercadao.db` |
| `tests/pdv/sprint-21-verificacao-vinculo-tef.test.js` | 14/14 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21v-vP31tq\mercadao.db` |

A suíte 21G insere as linhas e consulta. Não chama o orquestrador, o adquirente nem a SEFAZ.

Evidências da 21G:

1. Cartão único: um pagamento de 10, `tef_nsu` `NSU-CARTAO`, `tef_autorizacao` `AUT-CARTAO`, `tef_transacao_id` preenchido. O NSU da resposta é o da coluna `venda_pagamentos.tef_nsu`.
2. Dinheiro: forma `dinheiro`, `tef_nsu` nulo, `tef_transacao_id` nulo, `status_pagamento` `quitada`.
3. Dois meios: dinheiro 5 e débito 10. Soma dos pagamentos 15. `total` da resposta 15.
4. Mista: pagamento comercial 10, recebimentos fiscal 6 e não fiscal 4. `total` 10, `valor_fiscal` 6, `valor_nao_fiscal` 4. A soma das fatias é 10 e não entra no total.
5. O cartão do item 1 traz NSU e autorização persistidos.
6. O dinheiro do item 2 não tem transação TEF.
7. Header da empresa A devolve a venda.
8. Header da empresa B, operador autorizado nessa empresa, não devolve a venda da A e o corpo não contém `NSU-CARTAO`. A lista da B também não contém essa venda.
9. A lista da A traz `status` `concluida` e `status_pagamento` `quitada`, com `pagamentos_resumo` `cartao_credito|10.00`. O HTML da lista contém “Concluída” e “Quitado”. O modal contém os dois rótulos, `NSU-CARTAO` e `AUT-CARTAO`, e o total `R$ 10.00`.
10. Regressão: 21B/21E 14/14, 21C 7/7, vínculo TEF 14/14.

No cartão, a soma das duas listas é 20 e o `total` da resposta permanece 10. O cupom gerado contém `NSU: NSU-CARTAO` e `Total: R$ 10,00`, sem `Total: R$ 20,00`.

Contadores das suítes de regressão: 21B `autorizacoesReais` 0 e `emissoesFiscais` 0; 21C `autorizacoesReais` 0, `emissoesFiscais` 0 e `pagamentosMock` 1; vínculo `autorizacoesBloqueadas` 0 e `emissoesFiscais` 0.

A tela do histórico foi exercida em `vm`, carregando `vendasHistoricoUi.js` e `frontend/pdv/js/vendas.js` e chamando `renderVendas` e `showVendaModal`. O PDV autenticado no navegador não foi aberto: esta sprint não usa o banco oficial e não dispara operação financeira ou fiscal real.

## 5. Pendências

- `frontend/erp/js/vendas.js` é uma cópia paralela do histórico e não foi alterada. O escopo nomeia `frontend/pdv/js/vendas.js`.
- Acréscimo continua sem coluna em `vendas`. Corrigir isso exigiria migration, fora desta sprint.
- A ordem das formas em `pagamentos_resumo` segue a ordem do `GROUP_CONCAT` do SQLite.

## 6. Encerramento

A consulta individual devolve os pagamentos e recebimentos persistidos. O histórico separa status da venda e status do pagamento e mostra meios, valores, NSU e autorização da fonte gravada. A empresa da consulta continua filtrada. Os totais não são duplicados. As suítes 21B, 21C, 21E e 21F seguem aprovadas.

Nenhuma outra sprint foi iniciada. Aguardando avaliação do Tech Lead.
