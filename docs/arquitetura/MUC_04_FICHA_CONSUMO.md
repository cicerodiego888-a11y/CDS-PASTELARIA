# MUC-04 — Ficha técnica e consumo integrados ao MUC

**Status:** evolui 03.03/03.04; não reconstrói a ficha.  
**Autoridade de conversão:** `obterMuc(db).converterQuantidade`.  
**Autoridade de movimentação:** `debitarEstoqueItemVenda` / crédito de estorno, com `empresa_id` da venda.

---

## Arquitetura

```
Pedido operacional     (itens, personalizações e reservas; sem baixa física)
        ↓
Finalização da venda   (transação oficial do PDV)
        ↓
Requisitos físicos do Pedido (produto, ficha, personalizações e MUC)
        ↓
Estoque da empresa     (venda.empresa_id)
        ↓
Ledger de consumo do Pedido (snapshot físico reconciliável e estornável)
```

Ficha não converte. MotorUM não converte. Estoque não converte. A composição fiscal da venda não define o consumo físico do Pedido.

---

## Pedido operacional e venda

Salvar, editar, adicionar ou remover itens do Pedido atualiza requisitos e reservas comerciais, mas não debita o saldo físico. Reservas podem reduzir a disponibilidade para outras operações sem representar consumo. Pela regra MTS já existente, uma reserva que não tenha saldo fiscal suficiente pode também transferir saldo entre as classificações fiscal e não fiscal mediante autorização; essa transferência não reduz o saldo físico total, mas gera um movimento de classificação.

Na venda vinculada a Pedido, `VendaPagamentoService` mantém a baixa do consumo físico dentro da transação oficial de criação/finalização da venda:

1. Carrega as linhas persistidas do Pedido, incluindo snapshots de personalização.
2. Resolve requisitos físicos: ficha técnica, ingredientes personalizados e produtos simples.
3. Converte quantidades pelo MUC e valida o saldo da empresa da operação.
4. Debita uma única vez os requisitos do Pedido e grava o ledger vinculado à venda.
5. Qualquer falha reverte venda, débito e ledger na mesma transação.

Os itens fiscais preparados pela composição PDV não são usados como lista física de consumo. Vendas sem vínculo operacional com Pedido preservam o fluxo anterior de baixa da venda/ficha técnica.

O consumo é idempotente por Pedido e venda. Uma segunda tentativa para a mesma venda não debita novamente; outra venda para o Pedido já consumido é bloqueada.

### Geração e recuperação pela listagem

A listagem operacional oferece **Gerar venda no PDV** para Pedidos em `PEDIDO`, `ABERTO` ou `EM_SEPARACAO`, além da confirmação apresentada após salvar um Pedido novo. As duas entradas reutilizam `POST /api/pedidos/:id/preparar-venda-pdv` e o handoff oficial para o PDV. A aba **Concluídos** mantém os Pedidos faturados acessíveis para consulta do estado da venda vinculada, sem oferecer nova geração.

A composição de refrigerantes usa os dados e a cotação dos produtos elegíveis carregados do catálogo, inclusive quando um refrigerante complementar ainda não constava nas linhas originais do Pedido. Uma indisponibilidade ou ausência do produto no catálogo carregado bloqueia a composição; a preparação permanece sem efeitos de estoque.

O estado da operação `PDV_COMPOSICAO` orienta a recuperação sem criar uma segunda venda:

- `INICIADA`, sem `venda_id`: retoma a preparação e encaminha a composição ao PDV.
- `VENDA_CRIADA`, com `venda_id`: a listagem oferece concluir o vínculo pelo endpoint oficial. O serviço valida o estado do pagamento antes de concluir; uma pendência é exibida ao operador e não é marcada como finalizada.
- `FINALIZADA`: apresenta a venda vinculada sem oferecer nova geração.

A proteção local bloqueia cliques simultâneos; a exclusividade/idempotência da operação no backend continua sendo a autoridade contra requisições repetidas. A consulta da listagem trata `pedido_faturamento_operacoes` como opcional para continuar compatível com bancos legados que ainda não tenham essa tabela.

---

## MUC

`converterQuantidade({ quantidade, unidadeOrigem, unidadeDestino, relacoes })`.

- Destino: `unidade_estoque` se `utiliza_conversao = 1`; senão `produtos.unidade`.
- Relações/apresentações: só com flag SIM (MUC-03, `ProdutoConversaoConfigService.montarRelacoesMuc`).
- Flag NÃO + unidades diferentes: só o grafo SI do MUC (ex. G→KG, ML→L). Sem fallback MotorUM.
- UN→UN: identidade; `caminho` vazio. Sem aresta persistida.

Resultado do MUC é a quantidade final. A quantidade de estoque mantém até seis casas decimais durante o snapshot, a reserva e o débito. Por exemplo, `0,2 G` convertido para estoque `KG` resulta em `0,0002 KG`. Não aplicar `/1000` na ficha.

---

## Ficha

Cadastro exige **unidade explícita** por item (`quantidade` + `unidade`). Catálogo compartilhado, sem `empresa_id`.

Validação de código de unidade: MUC (`unidadesSi`); `MotorUnidadesMedida` permanece no cadastro só como catálogo comercial (03.03 T13), não como conversor.

INSUMO continua o único tipo consumível (03.03). COMERCIAL não vira insumo.

---

## Snapshot, cancelamento, devolução

O ledger guarda `quantidade` + `unidade` (estoque) e `quantidade_ficha` + `unidade_ficha`. O cancelamento estorna o consumo físico efetivo a partir do ledger e das reconciliações; não devolve automaticamente os itens fiscais compostos. Vendas sem ledger de Pedido continuam no fluxo comercial de devolução existente.

---

## Multiempresa

Mesma ficha, mesma regra MUC-03. Débito em `venda.empresa_id`. Empresa A não baixa B.

---

## Erros

`CONVERSAO_NAO_DISPONIVEL`, `CONVERSAO_INVALIDA`, `UNIDADE_INVALIDA`, `PRODUTO_SEM_UNIDADE_ESTOQUE`, `FICHA_INSUMO_INATIVO`, `SALDO_INSUFICIENTE`, `INSUMO_NAO_VENDAVEL` (venda). Sem estimar.

---

## MotorUM e legado

| Módulo | Papel após MUC-04 |
|---|---|
| `MotorUnidadesMedida` | Preço, UC, flags de embalagem. `converterQuantidadeEntreUnidades` ainda delega ao MUC para outros consumidores. **Não** é autoridade da ficha/consumo. |
| `motorConversaoUnidades.js` | DEPRECADO. Custo/F-NF no pipeline de compra. Sem novo consumidor. |

---

## Exemplos

- 300 ML, estoque L → 0,3 L
- 80 G queijo, estoque KG → 0,08 KG
- 20 UN laranja, 1 UN = 150 G, estoque KG → 3 KG
- 2 UN / estoque UN → 2 UN
