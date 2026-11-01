# Sprint 22 — Persistência do acréscimo da venda

O acréscimo do fechamento passa a ficar gravado em coluna própria de `vendas` e volta na consulta e no histórico, separado do total comercial.

Data: 31/10/2026.

Parecer: **APROVADA**.

## 1. Diagnóstico

O PDV calcula o acréscimo em `#acrescimoPdv` e envia `acrescimo` no corpo de `POST /api/vendas`. O total comercial enviado já é `subtotal - desconto + acréscimo`.

`criarVenda`, em `backend/services/vendas/VendaPagamentoService.js`, lê esse campo e o entrega ao Motor F×NF. `calcularValorFiscalLiquido` rateia desconto e acréscimo em conjunto, pelo fator `total líquido / subtotal bruto`, entre os valores fiscal e não fiscal. Não existe um terceiro bucket só de acréscimo.

A gravação ocorre dentro de `executarTransacaoVendaExclusiva` (`BEGIN IMMEDIATE`). O `INSERT` de venda à vista e o de venda a prazo gravavam `total` e `desconto`. O acréscimo não tinha coluna.

`pedidos` já usa `acrescimo REAL DEFAULT 0`. `vendas` não tinha o equivalente. A consulta `GET /api/vendas/:id` devolve `v.*`, então passaria a enxergar a coluna assim que ela existir. A listagem escolhe as colunas uma a uma e não pedia o acréscimo. O modal do histórico mostra o desconto e o total comercial (`vendas.total`). O cupom não fiscal imprime o total já líquido (`valor_nao_fiscal` quando ele é positivo) e o desconto como linha informativa, sem somar de novo.

O fechamento atual distribui cada venda em um único bucket: fiscal ou não fiscal. Uma venda nova pelo PDV não nasce com as duas fatias ao mesmo tempo. Vendas mistas já gravadas, como as da Sprint 21, continuam com `valor_fiscal` e `valor_nao_fiscal` preenchidos.

No faturamento de pedido, o acréscimo do pedido entra em `valor_outros` (`frete + acréscimo`) e em `pedidos.acrescimo`. O payload da venda não manda `body.acrescimo`. Essa identidade fecha com acréscimo de venda igual a zero. O valor do pedido permanece em `pedidos.acrescimo` e em `vendas.valor_outros`.

## 2. Causa-raiz

O acréscimo comercial era consumido só para compor `vendas.total` e o rateio líquido. Sem coluna, a consulta posterior não separava o acréscimo do total.

## 3. Modelagem e migration

Coluna `vendas.acrescimo REAL DEFAULT 0`, o mesmo nome e o mesmo padrão de `pedidos.acrescimo`.

A alteração entra na lista idempotente `alteracoesVendas` e passa por `aplicarAlteracaoSegura`. A segunda execução encontra `duplicate column name` e segue. Registros anteriores recebem 0. `INSERT` que não cita a coluna, como entrega e materialização de atendimento, também recebe 0.

O valor gravado no fechamento à vista e a prazo é o que fecha a identidade já aceita:

`total = subtotal dos itens - desconto + acréscimo + valor_outros`

Diferença acima de um centavo, valor negativo ou não numérico responde `400` com `ACRESCIMO_DIVERGENTE` ou `ACRESCIMO_INVALIDO`. A venda não é gravada. A consulta não recalcula `vendas.total`.

Rollback da aplicação: o código antigo continua inserindo sem a coluna, e o `DEFAULT 0` cobre a omissão. A coluna pode permanecer. A remoção física, se um dia for necessária, é `ALTER TABLE vendas DROP COLUMN acrescimo` em cópia de banco, no SQLite que aceita `DROP COLUMN`. Não foi executada. O banco oficial não foi migrado.

## 4. Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `backend/database.js` | `ALTER TABLE vendas ADD COLUMN acrescimo REAL DEFAULT 0` |
| `backend/services/vendas/VendaPagamentoService.js` | validação e gravação nas duas transações de fechamento |
| `backend/rotas/vendas.js` | `v.acrescimo` na listagem |
| `frontend/pdv/js/vendas.js` | coluna e campo do modal, separados do total |
| `frontend/shared/js/fiscalImpressao.js` | linha informativa no cupom; o total impresso não soma o acréscimo |
| `tests/pdv/sprint-22-persistencia-acrescimo.test.js` | suíte desta sprint |

O Motor F×NF, `valorFiscalLiquido.js`, o rateio, a autorização TEF, o vínculo único, o fluxo manual e o fluxo automático não foram alterados.

## 5. Testes

Banco `C:\Users\cicer\AppData\Local\Temp\cds-sprint22a-o2rJAA\mercadao.db`. Log: `BANCO DE TESTE EM USO`. `CDS_ALLOW_OFFICIAL_DB` ausente.

`node --test --test-concurrency=1 tests/pdv/sprint-22-persistencia-acrescimo.test.js`

8 testes, 8 aprovações. Autorizações reais de TEF: 0.

| Caso | Resultado |
|---|---|
| Venda sem acréscimo | `acrescimo` 0 e total 8,00 |
| Venda com acréscimo 2,00 | total 12,00; fiscal + não fiscal = 12,00; não virou 14,00 |
| Acréscimo 50 com total 10 | HTTP 400, `ACRESCIMO_DIVERGENTE`, nenhuma venda nova |
| Desconto 1,00 e acréscimo 2,00 | total 11,00, os dois campos gravados |
| Venda mista já persistida | total 10,00, fiscal 6,00, não fiscal 4,00, acréscimo 2,00 |
| Consulta `GET /api/vendas/:id` | devolve o acréscimo 2,00 e o total 10,00 |
| Histórico | lista e modal mostram R$ 10,00 e R$ 2,00, sem R$ 12,00 |
| Reimpressão | `Total: R$ 4,00` e `Acréscimo: R$ 2,00`; sem total 6,00, 12,00 ou 14,00 |
| Venda antiga sem a coluna no `INSERT` | `acrescimo` 0 e total 15,00 preservado |
| Falha `CDS_TEF_VINCULO_FALHA` dentro da transação exclusiva | HTTP 409, contagem de vendas inalterada, nenhum total 10 com acréscimo 1 |

Regressão, um arquivo por vez:

- `tests/pdv/sprint-21-etapa-g-consulta-historico.test.js`: 2/2. Banco `cds-sprint21g-5fbHOo`. A migration da coluna apareceu no log.
- `tests/pdv/sprint-21-etapa-c-manual-interface.test.js`: 7/7. Banco `cds-sprint21c-2RNakM`. Autorizações reais 0, emissões fiscais 0.

## 6. Compatibilidade histórica

Venda inserida sem citar `acrescimo` ficou com 0 e com o total original. A listagem e o modal tratam ausência como zero. O cupom imprime `Acréscimo: R$ 0,00` nesse caso e não altera a linha de total.

## 7. Ambiente

Somente bancos temporários. Nenhuma migration no banco oficial. Nenhum TEF, PIX, adquirente, NFC-e, NF-e ou evento à SEFAZ.

## 8. Parecer

**APROVADA.**

O acréscimo do fechamento fica gravado, validado e recuperável, separado do total comercial. A reimpressão não soma esse valor de novo.

Nenhuma outra sprint foi iniciada.
