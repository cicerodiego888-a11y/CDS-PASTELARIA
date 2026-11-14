# Validação fiscal da composição na Venda por Valor

**ID:** CDS-FISCAL-VALIDACAO-COMPOSICAO-VALOR-01  
**Base:** `docs/arquitetura/CORRECAO-DISTRIBUICAO-FISCAL-VENDA-POR-VALOR.md`  
**Ambiente:** SQLite em memória e banco temporário. Sem banco oficial, sem TEF, sem PIX real e sem transmissão à SEFAZ.  
**Produção:** nenhuma função de composição, fechamento, dinheiro ou emissor foi alterada.

## Classificação

- VALIDADO EM TESTES ISOLADOS
- VALIDADO NO XML LOCAL
- VALIDADO NO DANFE LOCAL
- PENDENTE DE HOMOLOGAÇÃO FISCAL
- A trilha de valores não está bloqueada

Não há homologação SEFAZ.

## 1. Pedido #68, etapa por etapa

Cadastro artificial: pastel #747 a R$ 8,99, copo 200 ml #748 a R$ 12,99, copo 300 ml #749 a R$ 19,80. Quantidade 2. Valor comercial R$ 61,98. PIX aprovado de R$ 61,98. Estoque fiscal suficiente para os três itens.

| Etapa | Pastel | Copo 200 ml | Copo 300 ml | Desconto | Total |
|---|---:|---:|---:|---:|---:|
| Pedido comercial | 2 × linha R$ 61,98 | — | — | R$ 0,00 no pedido | R$ 61,98 |
| Payload | 2 × R$ 17,98 | 2 × R$ 25,98 | 1 × R$ 19,80 | R$ 1,78 | R$ 61,98 |
| Contrato de fechamento | preserva os itens | preserva os itens | preserva os itens | R$ 1,78 no cabeçalho | R$ 61,98 |
| Distribuidor, `valor_fiscal` | R$ 17,98 | R$ 25,98 | R$ 19,80 | não volta para o item | líquido R$ 61,98 |
| XML, `vProd` / `vUnCom` | qCom 2, vUnCom 8,99, vProd 17,98 | qCom 2, vUnCom 12,99, vProd 25,98 | qCom 1, vUnCom 19,80, vProd 19,80 | vDesc do item 0,50 + 0,73 + 0,55 | vNF 61,98 |
| DANFE local | 17.98 | 25.98 | 19.80 | R$ 1,78 uma vez | R$ 61,98 |

A identidade `17,98 + 45,78 − 1,78 = 61,98` se mantém. Os componentes somam R$ 45,78 e aparecem em duas linhas, não como um desconto. A segunda preparação devolve o mesmo fingerprint e os mesmos itens. `pedidos_itens` continua com uma linha, a comercial de R$ 61,98.

O fechamento não recoloca R$ 61,98 no valor fiscal do pastel. O desconto técnico não volta a R$ 45,78. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece falso, então o emissor não está autorizado a trocar os itens da composição.

## 2. XML local, ambiente 2, sem assinatura e sem transmissão

Modelo `MODELO_BRUTO`. O desconto do cabeçalho é rateado nos itens e a soma desse rateio é o mesmo R$ 1,78. O DANFE não imprime o rateio de cada item. Imprime o desconto do cabeçalho uma vez. `vProd − vDesc = vNF`.

```xml
<det nItem="1">
  <prod>
    <cProd>747</cProd>
    <xProd>NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xProd>
    <qCom>2.0000</qCom>
    <vUnCom>8.9900000000</vUnCom>
    <vProd>17.98</vProd>
    <vDesc>0.50</vDesc>
  </prod>
</det>
<det nItem="2">
  <prod>
    <cProd>748</cProd>
    <xProd>Refrigerante Copo 200 ml</xProd>
    <qCom>2.0000</qCom>
    <vUnCom>12.9900000000</vUnCom>
    <vProd>25.98</vProd>
    <vDesc>0.73</vDesc>
  </prod>
</det>
<det nItem="3">
  <prod>
    <cProd>749</cProd>
    <xProd>Refrigerante Copo 300 ml</xProd>
    <qCom>1.0000</qCom>
    <vUnCom>19.8000000000</vUnCom>
    <vProd>19.80</vProd>
    <vDesc>0.55</vDesc>
  </prod>
</det>
<ICMSTot>
  <vProd>63.76</vProd>
  <vDesc>1.78</vDesc>
  <vNF>61.98</vNF>
</ICMSTot>
```

O primeiro `xProd` sai com o texto de homologação porque o ambiente do XML é 2. Quantidade, unitário e produto permanecem os do pastel. O DANFE local, montado com os mesmos itens, mostra o nome Pastel do Cheff, os três subtotais, o desconto R$ 1,78 e o total R$ 61,98.

## 3. DANFE local

Linhas impressas a partir de `valor_fiscal`: 17.98, 25.98 e 19.80. O total usa o valor da venda, R$ 61,98. A expressão `R$ 1,78` aparece uma vez. A expressão `R$ 45,78` não aparece.

## 4. Regressões

| Caso | Resultado |
|---|---|
| Combinação exata, R$ 30,97, 2 pastéis | Desconto R$ 0,00. Pastel fiscal R$ 17,98 e copo R$ 12,99. XML `MODELO_LIQUIDO`: vProd 30,97, vDesc 0,00, vNF 30,97. |
| Excedente | É o pedido #68: residual R$ 44,00, componentes R$ 45,78, desconto R$ 1,78. |
| Quantidade 1, total R$ 21,98 | Pastel fiscal R$ 8,99. O valor fiscal do pastel não vira o total comercial. Uma linha no pedido. |
| Quantidade 2, total R$ 61,98 | Pastel fiscal R$ 17,98. |
| Quantidade 3, total R$ 50,00 | Pastel fiscal R$ 26,97. Desconto igual a componentes menos residual. |
| Reabertura | Mesmo fingerprint e os mesmos itens. Sem segunda linha de copo no pedido. |
| Composição normal auditada | Desconto R$ 27,78. Pastel fiscal R$ 43,98. Líquido R$ 61,98. |
| Dinheiro confirmado R$ 61,98 | Fiscal R$ 0,00, não fiscal R$ 61,98, sem NFC-e. Margem R$ 12,40, 20%, `nao_e_desconto`. O pastel vai para `valor_nao_fiscal` R$ 17,98. |
| PIX aprovado R$ 61,98 | Fiscal R$ 61,98, não fiscal R$ 0,00, NFC-e autorizada pelo contrato. |
| PIX R$ 30,00 + dinheiro R$ 31,98 | Fiscal R$ 30,00, não fiscal R$ 31,98. NFC-e não emitida: `COMPOSICAO_PEDIDO_MISTA_SEM_NFC`. |

O percentual de tolerância permanece 0,2. A classificação do dinheiro e do PIX não foi recalculada por esta validação.

## 5. Divergências de valor

Nenhuma na trilha do pedido #68. O comercial R$ 61,98 fica no pedido. O fiscal do pastel fica R$ 17,98 do payload ao XML. O desconto técnico fica R$ 1,78. Os copos não duplicam.

## 6. Pendências fiscais

NCM `19059090`, CFOP `5102` e CSOSN `102` entraram só para o montador local de XML aceitar o documento. Não são cadastro fiscal dos produtos e não foram homologados. PIS e COFINS saem do modelo já existente do montador, CST `07`. Esta sprint não valida tributação.

O XML foi gerado por `buildNfceXml` em ambiente 2, sem assinatura e sem envio. O emissor completo, `emitirPorVendaId`, não foi executado. A troca de itens no emissor continua desligada.

Venda só em dinheiro não gera NFC-e. Venda mista continua sem NFC-e. A divisão do desconto técnico entre a parte digital e a parte em dinheiro não foi representada em XML.

O primeiro item do XML de homologação troca a descrição pelo aviso de ambiente 2. O DANFE local mantém o nome do produto. Os valores dos dois documentos são os mesmos.

## 7. Testes

`node --test --test-concurrency=1 tests/vendas/validacao-fiscal-composicao-venda-por-valor.test.js`

5 testes, 5 aprovações, 0 falhas.
