# Sprint FIN-INT-08 — Integridade empresarial dos recebíveis canônicos

**Tipo:** correção focada de backend com testes isolados  
**Data:** 2026-10-26  
**Homologação:** aguardando Tech Lead

## 1. Origem comprovada do `empresa_id`

Na criação regular de vendas, `VendaPagamentoService.criarVenda` resolve `empresaIdVenda` a partir do contexto operacional validado por `exigirEmpresaDaOperacao(req)` e verifica a compatibilidade do caixa com `exigirCaixaCompativelComVenda`. O valor é persistido na venda.

`MotorFinalizacaoVenda` carrega a venda persistida com `SELECT v.*`. O fluxo financeiro já resolvia a empresa pela venda e pelo caixa usando `resolverEmpresaDaOrigemFinanceira`, e gravava esse resultado em `financeiro.empresa_id`. A função oficial prioriza a empresa da venda e rejeita divergências entre venda, contexto operacional e caixa.

Foi identificado que o `INSERT` de `contas_receber` no fluxo de finalização não incluía `empresa_id`. Os outros escritores diretamente relacionados encontrados em `VendaPagamentoService.js` já persistem `empresaIdVenda`; permaneceram inalterados.

## 2. Arquivos alterados

- `backend/services/entrega/MotorFinalizacaoVenda.js`
  - Exige, antes de iniciar operações de pagamento, que a venda persistida tenha empresa proprietária válida.
  - Resolve a empresa do fluxo com base na venda, contexto operacional e caixa, rejeitando divergências.
  - Persiste `empresaIdFin` no `INSERT` canônico em `contas_receber`. O lançamento legado `financeiro` continua usando o mesmo `empresaIdFin`.
- `tests/vendas-entrega/fin-int-08-receber-ownership.test.js`
  - Adiciona testes de integração isolados com SQLite `:memory:` e dependências externas stubadas.
- `docs/financeiro/SPRINT-FIN-INT-08-RELATORIO.md`
  - Registra a auditoria, a correção e as validações.

Nenhum outro fluxo de criação de recebíveis foi alterado.

## 3. Comportamento anterior e corrigido

**Anterior:** o lançamento legado `financeiro` recebia a empresa resolvida da venda/contexto/caixa, mas o título canônico criado na finalização a prazo não gravava `empresa_id`.

**Corrigido:** ambos recebem o mesmo identificador empresarial resolvido e validado. Se a venda não tiver empresa proprietária válida, a finalização falha antes de iniciar processamento de pagamento ou escrita financeira. Se venda, contexto ou caixa divergirem, a operação é rejeitada antes da escrita.

Campos, valores, número de parcelas, vencimento e status existentes foram preservados.

## 4. Testes executados

### Teste novo isolado

```text
node --test tests\vendas-entrega\fin-int-08-receber-ownership.test.js
```

Resultado: **3/3 testes passaram**.

Cobertura:

1. Venda da empresa A e venda da empresa B geram recebíveis com a empresa correta.
2. Consultas por empresa isolam os recebíveis da outra empresa.
3. Recebível canônico e lançamento legado usam a mesma empresa, sem duplicar parcelas ou lançamentos.
4. Venda sem empresa proprietária falha sem criar recebível, lançamento legado ou marcar a prestação como realizada.
5. Contexto/caixa divergente da empresa da venda é rejeitado sem criar lançamentos.

O fixture usa SQLite `:memory:`; chamadas externas de pagamento, TEF, estoque, auditoria e emissão fiscal foram stubadas, sem executar operações reais.

### Regressão de ownership

```text
node tests\financeiro\ownership-financeiro-05-41.test.js
```

Resultado: **14/14 verificações passaram**.

### Sintaxe

`node --check` passou para:

- `backend/services/entrega/MotorFinalizacaoVenda.js`
- `tests/vendas-entrega/fin-int-08-receber-ownership.test.js`

## 5. Isolamento e ausência de duplicidade

Os testes verificaram vendas atribuídas a empresas diferentes e consultas SQL filtradas por `empresa_id`. Para as duas vendas de fixture, houve exatamente um recebível canônico e um lançamento legado por venda, ambos vinculados à empresa proprietária correspondente.

Os testes não conectam ao banco oficial ou a bancos de clientes. Não houve venda real, pagamento, baixa, evento fiscal, migração, backfill ou alteração de dados fora do banco em memória.

## 6. Limitações e itens pendentes

- A integração do motor foi exercitada com SQLite em memória e dependências periféricas stubadas; não foram iniciados serviços externos nem executada uma transação contra dados reais.
- Os escritores diretos de recebíveis em `VendaPagamentoService.js` foram inspecionados e já incluem `empresaIdVenda`; não foram modificados nem receberam teste novo nesta sprint.
- A regra de sobreposição do relatório FIN-INT-05 e seus filtros não foram alterados. A cobertura focou no ownership persistido no fluxo de finalização.

## 7. Estado

Critério de propriedade empresarial atendido para o fluxo identificado. Implementação e verificações focadas concluídas. A sprint para e aguarda homologação do Tech Lead.
