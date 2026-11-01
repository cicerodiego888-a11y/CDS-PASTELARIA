# Auditoria de continuidade — Sprint 23

A Sprint 23 colocou o pagamento misto em parcelas sequenciais e ligou essa lista à validação de composição e ao fechamento. A Sprint 24 homologou o pagamento manual sem TEF. Essa homologação não conclui a Sprint 23.

Data: 31/10/2026.

Auditoria somente leitura. Nenhum código foi alterado. O banco oficial não foi aberto. Não houve TEF real, PIX real, NFC-e, NF-e nem evento à SEFAZ.

Parecer: a máquina de parcelas e o fechamento não fiscal com três parcelas estão implementados e cobertos por teste. O fluxo real do PDV não está homologado na tela. Com TEF ligado e valor fiscal maior que zero, o fechamento substitui a lista sequencial por um único pagamento TEF. A recomposição continua só calculada.

## A. O que foi implementado

| Item | Classe |
| --- | --- |
| Modal sequencial no botão Pagamento Misto e no atalho 5 | CONCLUÍDO |
| Inclusão de débito, crédito, dinheiro, PIX e prazo, sem teto de três formas | CONCLUÍDO |
| Total informado e restante atualizados a cada inclusão | CONCLUÍDO |
| Remoção de parcela ainda não autorizada pelo TEF | CONCLUÍDO |
| Bloqueio de remoção de parcela TEF já aprovada | CONCLUÍDO |
| Autorização TEF na inclusão, uma parcela por vez, quando o TEF está ligado | CONCLUÍDO |
| Rejeição e falha de comunicação não entram na lista e não apagam as anteriores | CONCLUÍDO |
| Segundo clique durante a autorização responde `AUTORIZACAO_EM_CURSO` | CONCLUÍDO |
| Confirmação só habilita quando a soma fecha o total | CONCLUÍDO |
| Com dinheiro, a lista vai a `POST /api/vendas/composicao-sequencial` antes de confirmar | CONCLUÍDO |
| No fechamento, `pagamento_sequencial` revalida a soma em `criarVenda` | CONCLUÍDO |
| Parcelas que sobrevivem até o `POST /api/vendas` são gravadas em `venda_pagamentos` | CONCLUÍDO |
| Consulta da venda devolve as linhas de `venda_pagamentos` | CONCLUÍDO |
| Parcela TEF já aprovada não é autorizada de novo no ramo misto sem valor fiscal | CONCLUÍDO |
| Distribuidor oficial permanece exclusivo: a venda nova fica toda fiscal ou toda não fiscal | CONCLUÍDO |
| Flag `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece falsa | CONCLUÍDO |
| Pagamento manual da Sprint 24, com TEF desligado, conserva a lista mista | CONCLUÍDO |

## B. O que funciona no fluxo real

O operador abre o pagamento, escolhe Pagamento Misto e o modal sequencial é montado por `abrirPagamentoMisto`. O script `pagamentoSequencial.js` é carregado antes de `pdv.js`.

Com o TEF desligado, que é a configuração atual da pastelaria, cada parcela entra como informada, sem chamar o TEF. A soma e o restante são redesenhados na hora. A confirmação exige a soma igual ao total. Se houver dinheiro e a soma fechar, o PDV consulta a composição e só libera o botão com a composição válida. O fechamento cai no caminho manual da Sprint 24, marca cada parcela como manual e envia a lista. O backend recusa soma divergente antes de gravar.

Com o TEF ligado e a venda 100% não fiscal, o fechamento chama `processarPagamentosMistosTEF`, que pula parcela já aprovada.

Esses caminhos estão no código. A tela do PDV não foi exercitada nesta auditoria.

## C. O que está parcial

| Item | Classe | Evidência |
| --- | --- | --- |
| Alteração de parcela | PARCIAL | `PagamentoSequencial.alterar` existe e o teste cobre. O modal não tem controle para editar valor. |
| Composição antes do fechamento | PARCIAL | A consulta `composicao-sequencial` só dispara quando há dinheiro e a soma já fecha. Débito, crédito e PIX sem dinheiro confirmam sem essa consulta. A revalidação no `criarVenda` ainda ocorre se houver mais de uma parcela. |
| Persistência da composição | PARCIAL | `POST /api/vendas/composicao-sequencial` não grava. O que persiste são as parcelas, no fechamento. Margem e candidato fiscal não ficam armazenados. |
| Modalidade, operador e horário | PARCIAL | A Sprint 24 grava esses campos em `venda_pagamentos`. Parcela com transação TEF recebe modalidade `tef` e operador, e `confirmado_em` fica nulo. O histórico do PDV mostra forma, valor, transação, NSU e autorização. Não mostra modalidade, operador nem horário. |
| PIX dentro do misto com TEF desligado | PARCIAL | Se a parcela PIX não tem transação TEF e o PIX automático está ativo, a confirmação sai do fluxo sequencial e entra em `iniciarPixAutomaticoPDV`. |
| Prazo dentro do misto | PARCIAL | A forma avulsa a prazo exige cliente e vencimento. A parcela a prazo dentro do modal misto não passa por essa exigência, porque a forma da venda vira `misto`. |
| Homologação visual | NÃO HOMOLOGADO | O relatório da Sprint 23 já registrou que o modal não foi aberto num PDV real. Esta auditoria também não abriu a tela. |

## D. O que não foi implementado

| Item | Classe |
| --- | --- |
| Aplicar a recomposição no fechamento oficial | NÃO IMPLEMENTADO |
| Substituir o resultado do distribuidor oficial pela proposta de recomposição | NÃO IMPLEMENTADO |
| Estorno da transação TEF quando o operador abandona o modal depois da aprovação | NÃO IMPLEMENTADO |
| Edição de valor na tela do modal sequencial | NÃO IMPLEMENTADO |
| Homologação do modal no PDV aberto | NÃO HOMOLOGADO |

`avaliarPagamentosSequenciais` devolve `recomposicao_habilitada_em_producao: false` e `aplica_ao_fluxo_oficial: false`. `criarVenda` usa o retorno só para aceitar ou recusar a lista. Em seguida chama `distribuirItensVendaComValorFiscalEfetivo`. A margem de dinheiro não vira desconto nem valor fiscal.

## E. Defeitos

1. **COM DEFEITO — lista sequencial perdida quando há valor fiscal e o TEF está ligado.** Em `executarFinalizacaoVenda`, o ramo `deveUsarTefAutomatico && totalFiscal > 0` vem antes do ramo misto. Ele chama `processarVendaFiscalNaoFiscal`, autoriza um único valor fiscal e substitui `dados.pagamentos` por uma parcela só. Débito, crédito e dinheiro já montados deixam de ir ao backend. A parcela nova é outra autorização, não a reutilização das já aprovadas.

2. **COM DEFEITO — prazo no modal misto não herda o contrato da venda a prazo.** Cliente e primeiro vencimento não são exigidos. A parcela pode ser gravada como linha de `venda_pagamentos` sem gerar o contas a receber do caminho a prazo.

3. **NÃO HOMOLOGADO — abandono após cartão aprovado.** A transação TEF fica sem venda. O índice único impede reutilizá-la. Não há estorno. Isso já estava registrado na Sprint 23 e continua aberto.

4. **Divergência de tela e banco.** A consulta devolve modalidade, operador e `confirmado_em`. O modal de histórico não os apresenta. Parcela TEF aprovada não recebe `confirmado_em`.

Não foi classificado como defeito o bucket exclusivo. Uma venda nova continua inteira fiscal ou inteira não fiscal. A recomposição não entra nesse resultado.

## F. Arquivos e funções

- `frontend/pdv/index.html` — carrega `pagamentoSequencial.js` antes de `pdv.js`.
- `frontend/pdv/js/pagamentoSequencial.js` — `adicionar`, `cancelar`, `alterar`, `exportar`, `autorizarParcelasPendentes`, `composicaoValida`.
- `frontend/pdv/js/pdv.js` — `abrirPagamentoMisto`, `processarPagamentosMistosTEF`, `executarFinalizacaoVenda`. O ramo fiscal com TEF automático está por volta da condição `deveUsarTefAutomatico && totalFiscal > 0`. O ramo misto está no `else if` seguinte. O ramo manual da Sprint 24 conserva `pagamentosMistos`.
- `backend/services/vendas/PagamentoSequencialComposicaoService.js` — `avaliarPagamentosSequenciais`.
- `backend/rotas/vendas.js` — `POST /composicao-sequencial`, sem persistência. `GET /api/vendas/:id` devolve as parcelas, inclusive modalidade, operador e horário.
- `backend/services/vendas/VendaPagamentoService.js` — revalida quando `pagamento_sequencial` é verdadeiro e grava em `inserirPagamentosDaVenda`. O distribuidor oficial é `distribuirItensVendaComValorFiscalEfetivo`.
- `backend/services/vendas/RecomposicaoFiscalContratoService.js` — `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` é `false`.
- `frontend/pdv/js/vendas.js` — `htmlTabelaPagamentos` não mostra modalidade, operador nem horário.

Não foram alterados nesta auditoria o distribuidor oficial, o adaptador de recomposição nem a flag de produção.

## G. Testes executados

Suíte da Sprint 23, um arquivo, banco temporário:

`node --test --test-concurrency=1 tests/pdv/sprint-23-pagamento-sequencial-recomposicao.test.js`

Resultado: **5/5**. Banco `C:\Users\cicer\AppData\Local\Temp\cds-sprint23-fREeRU\mercadao.db`. Autorizações reais: 0. Emissões fiscais: 0.

| Camada | O que cobre | O que não cobre |
| --- | --- | --- |
| Unidade da máquina de parcelas | Inclusão, três parcelas, rejeição, timeout, duplo clique, alteração, bloqueio de edição da parcela aprovada | A tela do modal |
| Integração HTTP em banco temporário | Composição, soma divergente, persistência de três parcelas com TEF simulado, distribuidor oficial na venda não fiscal, comprovante sem NSU | Venda fiscal mista, prazo dentro do misto, consulta visual do histórico, PDV aberto |
| Fluxo real do PDV | Não executado | Modal, atalho 5, confirmação manual na tela, cancelamento da impressora |

Durante a inicialização do banco temporário apareceu `SQLITE_BUSY` em migrações internas. As cinco asserções passaram. O banco oficial não foi usado.

## H. Pendências para concluir a Sprint 23

1. Corrigir o fechamento para que, com TEF ligado e valor fiscal maior que zero, a lista sequencial seja a lista gravada, sem nova autorização das parcelas já aprovadas.
2. Ligar a alteração de valor no modal, ou retirar `alterar` do contrato da sprint se a tela não for tê-la.
3. Decidir o prazo dentro do misto: exigir cliente e vencimento, ou tirar a opção do modal.
4. Decidir o PIX automático depois da confirmação mista, para não abrir um segundo fluxo.
5. Gravar `confirmado_em` também na parcela TEF e mostrar modalidade, operador e horário na consulta, se esses campos forem obrigatórios na leitura do PDV.
6. Tratar a transação TEF órfã quando o modal é abandonado depois da aprovação.
7. Homologar o modal no PDV aberto: três parcelas, remoção, soma, confirmação, gravação e consulta. Sem TEF real, sem PIX real e sem emissão fiscal.
8. Manter a recomposição fora da produção até uma autorização própria. O cálculo já existe. A aplicação no distribuidor oficial não existe.

A frente da Sprint 23 não está concluída.

Aguardando avaliação do Tech Lead.
