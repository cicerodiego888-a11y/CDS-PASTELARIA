# Sprint 2 — Motor isolado de composição fiscal

## Escopo entregue

Foi implementado um simulador de composição fiscal para um Pedido existente. Ele é chamado diretamente, exige uma conexão SQLite explicitamente injetada e não possui rota nem integração com o PDV, pagamento, conclusão de venda ou efeitos operacionais.

Arquivos criados ou alterados:

- `backend/services/vendas/ComposicaoFiscalPedidoService.js` — valida Pedido, empresa, itens, catálogo, elegibilidade fiscal, volume MUC e disponibilidade fiscal; busca uma composição e devolve o resultado com fingerprint.
- `tests/vendas/sprint-2-motor-composicao-fiscal.test.js` — testes dirigidos com SQLite em memória.
- `docs/vendas/sprint-2-motor-composicao-fiscal-relatorio.md` — este relatório.

## Dados de preço e desconto

O cadastro examinado não oferece um preço fiscal persistido por empresa/modelo. A elegibilidade é vinculada por empresa e categoria, mas o preço disponível é `produtos.preco_venda`, compartilhado no catálogo. O simulador usa esse campo como preço corrente e informa sua origem no resultado. Portanto, preço fiscal diferenciado por empresa não é representado por esta implementação.

Também não foi localizada uma política persistida de desconto máximo. Para não inventar um limite, a simulação:

1. procura primeiro uma composição exata, sem desconto;
2. só procura uma composição abaixo do total quando recebe `resolverPoliticaDesconto` explicitamente;
3. exige da política um limite inteiro não negativo em centavos e uma fonte identificável;
4. bloqueia a busca com `LIMITE_DESCONTO_NAO_CONFIGURADO` quando não há política.

O resolver é apenas uma dependência do contrato do simulador; não foi criada nem conectada uma política de produção.

## Regras implementadas

- Aceita apenas Pedidos da empresa explícita informada, nos estados `PEDIDO` ou `EM_SEPARACAO`.
- Valida o total persistido contra a soma dos subtotais, desconto e frete. Frete diferente de zero não é composto nesta sprint.
- Itens fiscais fixos precisam corresponder a produtos e quantidades presentes no Pedido. O preço é obtido do catálogo, nunca de um valor fornecido pelo chamador.
- Modelos fiscais são elegíveis somente por vínculo explícito da empresa e categoria `REFRIGERANTE` ou `AGUA`. Produto inativo, insumo, preço inválido ou volume ausente/inválido não entra na composição.
- Converte o volume cadastrado para mililitros inteiros através do núcleo puro do MUC, sem instanciar serviços que garantam schema.
- Considera o saldo fiscal compartilhado em ml. Saldo reservado a outros Pedidos permanece indisponível; uma reserva ativa do próprio Pedido pode ser somada de volta uma única vez. Se o schema de reserva estiver parcial, a simulação falha explicitamente.
- Confere se a soma das reservas ativas coincide com `saldo_reservado_ml`; divergência bloqueia a simulação em vez de assumir disponibilidade.
- Busca combinações determinísticas com limite de estados. Exceder o limite resulta em erro, não em declaração de sucesso.
- O fingerprint cobre Pedido, itens, catálogo, vínculos elegíveis, modelos e saldos/reservas observados. Se informado, um fingerprint anterior divergente é rejeitado antes de tentar nova composição.
- Não cria nem altera Pedido, venda, estoque físico, consumo de ficha técnica, financeiro, saldo fiscal ou reserva.

## Testes executados

Comando executado, sequencialmente:

```text
node --test tests\vendas\sprint-2-motor-composicao-fiscal.test.js
```

O processo foi executado com `DB_DIR` removido do ambiente. Os fixtures de negócio usam SQLite `:memory:`; não foi necessário abrir nem configurar um caminho de banco do aplicativo.

Resultado real: **19 testes passaram; 0 falharam**.

Cobertura efetivamente executada:

- fechamento exato e cálculo do residual do exemplo (Pedido de R$ 61,98, itens fixos de R$ 17,98 e composição residual de R$ 44,00);
- prioridade da composição exata sobre uma política de desconto disponível;
- uso conjunto das categorias `REFRIGERANTE` e `AGUA`;
- menor desconto atingível dentro do limite, ausência de limite e limite insuficiente;
- ausência de modelos elegíveis, exclusão de inativo, insumo, volume ausente, preço negativo e conversão fracionária;
- saldo insuficiente, reserva de outro Pedido, crédito único da reserva ativa do Pedido consultado e bloqueio por divergência no total reservado;
- conversão de volume por regra MUC;
- empresa obrigatória, isolamento do Pedido e isolamento dos modelos elegíveis por empresa;
- status não elegível, frete, total inconsistente, item fixo fora do Pedido e quantidade inválida;
- determinismo e rejeição de fingerprint desatualizado após alteração do catálogo;
- invariância dos dados operacionais e do schema SQLite antes/depois da simulação.

Não foi executada a suíte completa do projeto nem teste de integração com PDV.

## Limitações e riscos residuais

- `produtos.preco_venda` é preço global do catálogo, não preço fiscal por empresa. A composição pode refletir um preço que não seja o preço fiscal que o negócio venha a configurar futuramente.
- Não há configuração de desconto persistida nem resolver de produção. Sem a política injetada, resultados que exijam desconto são bloqueados.
- O fingerprint detecta alterações nas fontes lidas pela simulação, mas a validação não reserva saldo nem impede que ele mude depois do cálculo. Qualquer consumidor futuro deve revalidar o fingerprint imediatamente antes do uso e implementar sua própria coordenação transacional.
- A busca limitada pode rejeitar cenários complexos com `COMPOSICAO_BUSCA_COMPLEXA`; esse resultado não significa que inexista uma combinação.
- O simulador não escolhe nem importa automaticamente os itens fixos no carrinho: a interpretação e apresentação dos resultados ao operador permanecem fora deste escopo.

## Segurança e isolamento

O serviço não importa `PedidoRepository`, `database.js` ou serviços de aplicação que garantam schema. As consultas e a conversão utilizam exclusivamente a conexão recebida. O serviço exige que schemas necessários já existam e não executa DDL.

**Confirmação:** nenhum banco oficial ou operacional foi aberto, consultado, migrado ou alterado. Nenhuma operação SEFAZ, PDV, pagamento, baixa física, consumo de ficha técnica ou lançamento financeiro foi executada.
