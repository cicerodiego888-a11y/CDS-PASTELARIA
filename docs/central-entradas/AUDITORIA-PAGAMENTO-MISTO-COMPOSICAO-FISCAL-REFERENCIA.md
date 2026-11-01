# Auditoria — pagamento misto e composição fiscal de referência

Somente leitura. Nenhum código foi alterado. Nenhum banco oficial foi aberto.

Data: 31/10/2026.

Cenário: venda R$ 50,00, débito R$ 20,00, crédito R$ 20,00, dinheiro R$ 10,00. Composição fiscal de referência citada pelo Product Owner: R$ 40,00.

Parecer: o pagamento sequencial e o total financeiro de R$ 50,00 estão no fluxo real. A composição fiscal de R$ 40,00 não é calculada, não é avaliada pelo motor e não é persistida.

## 1. Funções de cada etapa

| Etapa | Arquivo | Função |
| --- | --- | --- |
| Escolha da forma e pedido do valor | `frontend/pdv/js/interacaoPagamentoMisto.js` | `escolherForma`, `confirmarValor` |
| Autorização individual | `frontend/pdv/js/pagamentoSequencial.js` | `adicionar` |
| Tela do misto | `frontend/pdv/js/pdv.js` | `abrirPagamentoMisto`, `avaliarSeHouverDinheiro` |
| Validação da lista, sem persistir | `backend/rotas/vendas.js` | `POST /api/vendas/composicao-sequencial` |
| Avaliação chamada pelo PDV | `backend/services/vendas/PagamentoSequencialComposicaoService.js` | `avaliarPagamentosSequenciais` |
| Contrato isolado | `backend/services/vendas/RecomposicaoFiscalContratoService.js` | `prepararContratoRecomposicaoFiscal` |
| Margem de 20% do dinheiro | `backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService.js` | `calcularMargemToleranciaDinheiro` |
| Fechamento e gravação | `frontend/pdv/js/pdv.js` e `backend/services/vendas/VendaPagamentoService.js` | `executarFinalizacaoVenda`, `criarVenda` |
| Distribuição oficial | `backend/services/distribuidorEstoqueVenda.js` | `distribuirItensVendaComValorFiscalEfetivo` |
| Motor de composição | `backend/services/vendas/RecomposicaoFiscalComposicaoMotorSimulacaoService.js` | `avaliarCandidatosComMotorComposicao` — fora do PDV |

## 2. Fluxo real

1. O operador escolhe crédito, débito ou dinheiro. `escolherForma` só abre o campo de valor. Não autoriza e não recompõe o pedido.
2. A confirmação do valor chama `PagamentoSequencial.adicionar`.
3. Com o TEF ligado e a forma configurada para TEF, `adicionar` espera o retorno de `autorizarTef`. Só depois grava `status_autorizacao = aprovada` e inclui a parcela na lista. Recusa ou timeout não entram na lista.
4. Dinheiro não chama autorização. A parcela fica `informada`.
5. Depois de cada confirmação, `avaliarSeHouverDinheiro` só segue se já existe dinheiro e a soma fecha o total. Aí faz `POST /api/vendas/composicao-sequencial`. A rota não grava venda.
6. O retorno fica na memória (`registrarComposicao`). O corpo da venda não envia `valor_fiscal_candidato`.
7. No fechamento, a lista sequencial segue para `criarVenda`. `avaliarPagamentosSequenciais` roda de novo e o retorno é descartado. A soma divergente responde 400.
8. O distribuidor oficial recebe os itens, o flag `vendaFiscal` e os pagamentos. O bucket é exclusivo: a venda inteira fica fiscal ou não fiscal.

## 3. Resultado de cada verificação

### A. Pagamentos

| Verificação | Resultado |
| --- | --- |
| Débito e crédito autorizados individualmente | IMPLEMENTADO com TEF ligado. Cada confirmação de valor gera uma autorização. Com TEF desligado, não há autorização bancária: a parcela fica para confirmação manual. |
| Retorno bancário antes de marcar aprovada | IMPLEMENTADO. `adicionar` só marca `aprovada` depois do retorno positivo. |
| Dinheiro executa a recomposição ao ser selecionado | NÃO IMPLEMENTADO. Selecionar dinheiro só pede o valor. A chamada posterior valida a lista; não recompõe itens nem produz R$ 40,00. |
| As três parcelas chegam à persistência | IMPLEMENTADO no fechamento sequencial. |
| Total financeiro permanece R$ 50,00 | IMPLEMENTADO. |

### B. Recomposição do pedido

| Verificação | Resultado |
| --- | --- |
| Função ao selecionar dinheiro | A seleção chama `escolherForma`. A função posterior, e só com a soma fechada, é `avaliarSeHouverDinheiro` → `avaliarPagamentosSequenciais`. |
| Calcula ou prepara a referência fiscal | NÃO IMPLEMENTADO no fluxo real. O retorno fixa `valor_fiscal_candidato: null`. |
| R$ 40,00 é calculado | NÃO IMPLEMENTADO. |
| Regra e dados desse valor | O número 40 aparece só como exemplo de entrada no comentário de `prepararContratoRecomposicaoFiscal`. O PDV não envia esse campo. O cálculo que a seleção de dinheiro dispara é a margem de 20% sobre o dinheiro: R$ 10,00 × 0,2 = R$ 2,00. Essa margem não vira valor fiscal nem desconto. |
| Resultado preservado no fechamento | NÃO IMPLEMENTADO. `criarVenda` ignora o objeto retornado. Não há coluna de composição de referência. |

### C. Motor fiscal e distribuidor

| Verificação | Resultado |
| --- | --- |
| Motor de composição no fluxo real | NÃO IMPLEMENTADO. `avaliarCandidatosComMotorComposicao` não é chamado por `criarVenda` nem pelo PDV. |
| Referência fiscal avaliada | NÃO IMPLEMENTADO. No fluxo do PDV o candidato é nulo e `aplica_ao_fluxo_oficial` é falso. |
| Distribuidor recebe o resultado de R$ 40,00 | NÃO IMPLEMENTADO. O distribuidor recebe a venda e os pagamentos, e distribui o bucket exclusivo do estoque. |
| Composição fiscal aplicada sem mudar o total | NÃO IMPLEMENTADO. O contrato isolado declara `altera_vendas_total: false`, mas não é aplicado. O total de R$ 50,00 permanece porque a venda grava o total comercial, não porque a referência de R$ 40,00 foi aplicada. |
| Recomposição em produção desligada | IMPLEMENTADO. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece `false`. |

### D. Persistência e consulta

| Dado | Resultado |
| --- | --- |
| Total financeiro R$ 50,00 | IMPLEMENTADO em `vendas.total`. |
| Débito R$ 20,00, crédito R$ 20,00, dinheiro R$ 10,00 | IMPLEMENTADO em `venda_pagamentos`, uma linha por parcela. |
| Composição fiscal de referência R$ 40,00 | NÃO IMPLEMENTADO. Não há campo persistido para essa referência. |

## 4. Evidência do cenário R$ 50,00 / R$ 40,00

Sonda em memória, sem banco, da função que o PDV chama:

- `valor_fiscal_candidato`: null
- `valor_fiscal_presumido`: false
- `aplica_ao_fluxo_oficial`: false
- `recomposicao_habilitada_em_producao`: false
- `total_financeiro`: 50
- parcelas: débito 20, crédito 20, dinheiro 10
- margem: dinheiro recebido 10, percentual 0,2, margem máxima 2

O mesmo contrato, se alguém informar o candidato 40 na chamada, devolve `valor_fiscal_candidato` 40 e `valor_nao_fiscal_candidato` 10, com `aplica_ao_fluxo_oficial` false e `altera_vendas_total` false. O PDV não faz essa chamada.

Sonda em memória do distribuidor oficial, com os três pagamentos e item de R$ 50,00:

- estoque fiscal e `vendaFiscal` verdadeiro: valor fiscal 50, valor não fiscal 0
- estoque não fiscal e `vendaFiscal` falso: valor fiscal 0, valor não fiscal 50

Nenhum dos dois resultados é 40.

A suíte já executada em banco temporário (`C:\Users\cicer\AppData\Local\Temp\cds-sprint25-xffAiJ\mercadao.db`) gravou as três parcelas e o total 50. Na venda fiscal, `valor_fiscal` ficou 50. Essa suíte não foi reexecutada nesta auditoria.

## 5. Três valores diferentes

- Total financeiro: R$ 50,00. É a soma das parcelas e o valor gravado em `vendas.total`.
- Composição fiscal de referência: R$ 40,00. Existe como exemplo de entrada do contrato isolado. O fluxo real não a calcula e não a grava.
- Distribuição fiscal persistida: 0 ou 50, conforme o bucket exclusivo do estoque. Não é a referência de R$ 40,00.

## 6. Lacunas e riscos

- Selecionar dinheiro não recompõe o pedido. A validação só ocorre quando a soma já fechou, e o candidato fiscal sai nulo.
- R$ 40,00 não é derivado de débito mais crédito, nem de total menos dinheiro, em nenhuma função do fechamento.
- A margem de R$ 2,00 não é aplicada e não substitui a referência de R$ 40,00.
- O distribuidor oficial não parte uma venda de R$ 50,00 em fiscal 40 e não fiscal 10. O bucket é exclusivo.
- Ligar a recomposição em produção não está disponível: a flag permanece falsa e o PDV não encaminha proposta ao distribuidor.
- Com o TEF desligado, débito e crédito não recebem autorização bancária. Isso é o caminho manual já existente, e não atende sozinho o cenário que exige retorno bancário.

## 7. Confirmação

Nenhum arquivo de código foi alterado nesta auditoria. Nenhum banco oficial foi aberto, migrado ou modificado. A sonda não carregou `backend/database.js`. Não houve TEF, PIX, adquirente, NFC-e, NF-e nem evento à SEFAZ.

A auditoria aguarda avaliação do Tech Lead. Nenhuma correção foi implementada.
