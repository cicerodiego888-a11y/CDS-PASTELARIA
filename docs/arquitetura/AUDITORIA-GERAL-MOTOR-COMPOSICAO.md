# Auditoria geral do motor de composição

**Aditivo:** CDS-COMPOSICAO-AUDIT-GERAL-01  
**Classificação:** DEFEITO DE DISTRIBUIÇÃO CONFIRMADO  
**Escopo:** somente leitura. Nenhum código de produção, teste existente, regra de 20%, classificação fiscal/não fiscal, estoque, fechamento ou emissor foi alterado. Banco oficial, TEF, PIX e SEFAZ não foram acessados. Os números abaixo saíram de um SQLite `:memory:` com o cadastro artificial já usado pelos testes do motor: pastel #747 a R$ 8,99, copo 200 ml #748 a R$ 12,99, copo 300 ml #749 a R$ 19,80, copo 500 ml #750 a R$ 32,99.

O total final de R$ 61,98 coincide com o valor informado porque o desconto é definido como `bruto − total`. Essa igualdade não mostra que o valor foi distribuído.

## 1. O que o pedido #68 está fazendo

A conferência descrita é a saída atual da Venda por Valor, reproduzida no caso 1:

| Item | Quantidade | Subtotal |
|---|---:|---:|
| #747 Pastel do Cheff | 2 | R$ 61,98 |
| #748 Copo 200 ml | 2 | R$ 25,98 |
| #749 Copo 300 ml | 1 | R$ 19,80 |
| Soma | | R$ 107,76 |
| Desconto | | R$ 45,78 |
| Total | | R$ 61,98 |

R$ 25,98 é 2 × R$ 12,99. R$ 19,80 é 1 × R$ 19,80. A soma dos copos é R$ 45,78, igual ao desconto. O líquido volta a R$ 61,98 porque o desconto cancela os copos inteiros, não só o excedente da busca.

A busca dos copos usa outro número. O cadastro de dois pastéis é 2 × R$ 8,99 = R$ 17,98. O residual da busca é R$ 61,98 − R$ 17,98 = R$ 44,00. Não há combinação inteira em R$ 44,00. A menor combinação acima é 2 × R$ 12,99 + 1 × R$ 19,80 = R$ 45,78. O excedente real da busca é R$ 1,78. O desconto gravado na conferência é R$ 45,78.

## 2. Respostas objetivas

1. O valor informado é o total final do pedido e, ao mesmo tempo, o subtotal da linha do pastel. `montarItemPedidoPastel` divide esse total pela quantidade e grava o resultado na linha principal. Para R$ 61,98 e quantidade 2, a linha fica com unitário R$ 30,99 e subtotal R$ 61,98.
2. O produto principal recebe o valor integral antes da composição. `persistirMassaMonetariaPedidoAlvo` grava esse subtotal e zera `pedidos.desconto` antes de chamar o motor.
3. Os componentes são acrescentados por cima. A seleção não reparte os R$ 61,98. Ela compra copos suficientes para cobrir o residual do cadastro, R$ 44,00.
4. O desconto é calculado depois, para devolver o líquido ao total do pedido. Quando a linha do pastel já é o total, o desconto fica igual à soma dos copos.
5. Não há rateio proporcional do valor informado. Há soma de preços de cadastro dos copos com o subtotal comercial do pastel, e um desconto global que fecha a conta.
6. A busca encerra na combinação exata do residual ou, se ela não existir, na menor combinação inteira acima do residual, limitada a uma unidade do copo mais caro. Ela não encerra quando a linha do pastel já contém o valor informado. Essa parada não existe neste fluxo.
7. O total entra quatro vezes: valor informado, total do pedido, residual `total − cotação de cadastro`, e líquido `soma das linhas emitidas − desconto`. O líquido é forçado a ser o total do pedido. Se essa conta não fechar, a geração aborta com `TOTAL_COMPOSICAO_DIVERGENTE`.
8. A conferência não recalcula. Ela imprime `data.desconto` e `data.itens` da resposta. O PDV copia o mesmo `desconto` para `#descontoPdv` e não refaz a composição. Os dois valores divergentes são duas respostas do mesmo motor, com subtotais de pastel diferentes.

## 3. Os dois caminhos usam o mesmo motor

Os dois caminhos chamam `prepararComposicaoPedidoPdv`. A busca é `buscarComposicao`: primeiro objetivo exato, depois `MINIMO` acima do residual. A Venda por Valor acrescenta um passo que a composição normal não tem: grava a massa monetária inteira na linha do pastel e só então chama o motor.

```450:464:backend/services/vendas/VendaPorValorPasteisService.js
  const composicao = await prepararComposicao({
    pedidoId,
    empresaId
  }, { db });

  const payload = {
    pedidoId: composicao.pedidoId,
    empresaId: composicao.empresaId,
    fingerprint: composicao.fingerprint,
    total: composicao.valorFinalCentavos / 100,
    desconto: composicao.desconto,
    valor_composicao_bruto: composicao.valorCompostoBrutoCentavos / 100,
```

A linha emitida do pastel é o preço comercial persistido, não a cotação. O residual continua sendo a cotação:

```567:571:backend/services/vendas/PedidoPdvComposicaoService.js
  const valorPastelCentavos = itensPastel.reduce(
    (total, item) => somarCentavos(total, item.subtotal),
    0
  );
  const residualCentavos = totalCentavos - valorPastelCatalogoCentavos;
```

O desconto é a sobra da soma:

```687:692:backend/services/vendas/PedidoPdvComposicaoService.js
  const totalCompostoCentavos = itensVenda.reduce(
    (total, item) => somarCentavos(total, item.subtotal),
    0
  );
  const descontoCentavos = totalCompostoCentavos - totalCentavos;
  const totalLiquidoCentavos = totalCompostoCentavos - descontoCentavos;
```

Identidade medida nos dois caminhos, com os mesmos copos e o mesmo residual de R$ 44,00:

`desconto = subtotal comercial do pastel + copos − total do pedido`

- Caminho B, Venda por Valor: 61,98 + 45,78 − 61,98 = **45,78**.
- Caminho A, composição normal com a linha 2 × 21,99 = 43,98 e o total 61,98: 43,98 + 45,78 − 61,98 = **27,78**.

A diferença é 45,78 − 27,78 = 18,00, que é 61,98 − 43,98. Os copos não mudam. Muda só o subtotal comercial que já estava na linha do pastel.

Quando o comercial é igual ao cadastro, o desconto do caminho A reduz ao excedente da busca: copos − residual. No caso exato, esse excedente é zero. No caminho B o desconto continua sendo a soma dos copos, mesmo quando a combinação fecha o residual em centavo.

## 4. De onde saem R$ 27,78 e R$ 45,78

São o mesmo campo, em duas respostas.

| Tela | Campo | Origem | Valor neste cenário |
|---|---|---|---:|
| Conferência da Venda por Valor | rótulo "Desconto composição" sobre `data.desconto` | `composicao.desconto` depois da massa de R$ 61,98 | R$ 45,78 |
| Resumo do PDV | `#descontoPdv` | `handoff.desconto` do payload carregado | R$ 27,78 quando o payload veio da linha comercial de R$ 43,98 |

A conferência formata o campo da resposta. Não existe um segundo cálculo no navegador:

```204:206:frontend/pdv/js/pdv-venda-por-valor.js
              <div class="d-flex justify-content-between align-items-center">
                <span>Desconto composição: <strong>${formatarMoeda(data.desconto || 0)}</strong></span>
                <span class="fs-5">Total: <strong>${formatarMoeda(data.total)}</strong></span>
```

O PDV grava esse mesmo número e trava o campo. `atualizarCarrinho` lê `#descontoPdv`; não recompoe o pedido:

```579:582:frontend/pdv/js/pdv.js
        $('#descontoPdv').val((descontoHandoffCentavos / 100).toFixed(2));
        $('#acrescimoPdv').val(0);
        atualizarCarrinho();
        $('#descontoPdv, #acrescimoPdv').prop('disabled', true);
```

Antes de aceitar o handoff, o PDV exige `soma dos subtotais − desconto = total`. Um payload de R$ 45,78 passa nessa conta com bruto R$ 107,76. O PDV não converte R$ 45,78 em R$ 27,78.

Não são três descontos empilhados:

- Desconto comercial de item fica zerado na linha do pastel emitida (`desconto_percentual`, `desconto_valor`, `desconto_atacado` e `desconto_manual` saem 0).
- Desconto técnico e desconto de composição são o mesmo `desconto` do cabeçalho: `bruto emitido − total do pedido`.
- `pedidos.desconto` é gravado 0 na massa monetária. O desconto da conferência não mora nessa coluna. Ele mora na resposta e, depois de `prepararOperacaoPdv`, no `payload_json` da operação.
- Enquanto não existe `venda_id`, uma nova preparação recalcula e substitui o `payload_json`. Depois da venda, a rota devolve o snapshot gravado e não recalcula.

O PDV mostra R$ 27,78 quando o handoff em memória, `sessionStorage.pdvPedidoHandoff`, foi produzido pela composição normal da linha de R$ 43,98. A conferência do pedido #68 mostra R$ 45,78 porque a Venda por Valor já reescreveu a linha para R$ 61,98. Confirmar a conferência substitui o handoff. Os dois números não se somam.

## 5. Separação dos defeitos

### Busca de componentes

A busca fez o que o código pede. Residual R$ 44,00, sem combinação exata, menor combinação acima R$ 45,78, os mesmos copos no caminho A e no caminho B. Reabrir a mesma linha não troca a seleção. O excedente da busca é R$ 1,78. A busca não é a origem do desconto de R$ 45,78.

### Distribuição do valor

Este é o defeito do pedido #68. O valor informado é escrito por inteiro na linha do pastel. Os copos entram depois, pelo preço de cadastro, para cobrir um residual calculado com outro preço (R$ 8,99). O valor informado não é repartido entre pastel e copos.

A massa está em `montarItemPedidoPastel`: subtotal = total informado, unitário = subtotal / quantidade. O comentário do serviço registra a intenção atual: a linha do pastel carrega a massa, e o motor recota o pastel para achar o residual.

### Cálculo do desconto

O desconto não é o excedente de R$ 1,78. É `soma emitida − total`. Com a linha do pastel já igual ao total, ele fica igual aos copos: R$ 45,78. No caso exato reproduzido, o caminho normal fecha com desconto R$ 0,00. A Venda por Valor, com a mesma combinação exata, gera desconto de R$ 23,00, que é o valor inteiro dos copos. O desconto compensa o acréscimo. Não mede o quanto a combinação passou do residual.

### Persistência e conferência

`prepararComposicaoPedidoPdv` não grava item. Nas reexecuções, `pedidos_itens` continuou com uma linha, o pastel a R$ 61,98. Os copos existem no payload da conferência e do handoff. A segunda chamada devolveu o mesmo fingerprint, os mesmos itens e o mesmo desconto de R$ 45,78. Não há duplicação de componente nem de desconto numa reabertura da mesma linha.

A conferência cancela sem carregar o PDV e não apaga o pedido. O pedido permanece com a massa gravada e `desconto = 0`.

### Divergência PDV × conferência

R$ 27,78 e R$ 45,78 são a mesma fórmula com subtotais de pastel diferentes e a mesma seleção de copos. Não é campo antigo recalculado na conferência, nem desconto comercial somado ao técnico. É a distância de R$ 18,00 entre a linha normal de 2 × R$ 21,99 e a massa de R$ 61,98.

## 6. Casos reproduzidos

Cadastro artificial. Preços fora do caso estão indicados na linha. Nenhum efeito de estoque: a composição declara `efeitosOperacionais` falso e os saldos do banco temporário não foram baixados.

### Caso 1 — Venda por valor R$ 61,98, quantidade 2

Valor informado R$ 61,98. Linha distribuída antes da busca: #747 × 2 = R$ 61,98. Residual de cadastro R$ 44,00. Copos: #748 × 2 = R$ 25,98 e #749 × 1 = R$ 19,80. Bruto R$ 107,76. Desconto R$ 45,78. Total R$ 61,98. Modo `COMPOSICAO_PASTEL_REFRIGERANTE`.

### Caso 2 — a combinação cobre o residual, com excedente

Cadastro dos copos: 200 ml R$ 22,00, 300 ml R$ 50,00, 500 ml R$ 80,00. Valor informado R$ 40,98 em dois pastéis. Residual R$ 23,00. Um copo de R$ 22,00 não cobre. A menor combinação acima é 2 × R$ 22,00 = R$ 44,00.

- Venda por Valor: pastel R$ 40,98, copos R$ 44,00, bruto R$ 84,98, desconto R$ 44,00, total R$ 40,98. O excedente da busca seria R$ 21,00. O desconto levado à tela é o copo inteiro.
- Composição normal, pastel no cadastro R$ 17,98 e R$ 23,00 numa linha auxiliar para o pedido fechar: mesmos copos, bruto R$ 61,98, desconto R$ 21,00, total R$ 40,98. Aqui o desconto é o excedente.

### Caso 3 — combinação exata

Copo de 200 ml a R$ 11,50. Residual R$ 23,00. Seleção: #748 × 2 = R$ 23,00.

- Composição normal, comercial igual ao cadastro: bruto R$ 40,98, desconto R$ 0,00, total R$ 40,98.
- Venda por Valor, mesma seleção: pastel R$ 40,98, copos R$ 23,00, bruto R$ 63,98, desconto R$ 23,00, total R$ 40,98.

### Caso 4 — sem combinação exata

É o caso 1 de novo, com outro id de pedido. Residual R$ 44,00, copos R$ 45,78, desconto R$ 45,78, total R$ 61,98. O fingerprint muda porque o pedido muda. Itens, residual e desconto não mudam.

### Caso 5 — composição normal, quantidade 2

Pedido no formato do cenário já coberto pelo teste do motor: #747 × 2 a R$ 21,99 = R$ 43,98, mais uma linha auxiliar de R$ 18,00, total R$ 61,98. A linha auxiliar só fecha o pedido. Ela não é emitida.

Residual R$ 44,00. Copos iguais aos do caso 1. Pastel emitido R$ 43,98. Bruto R$ 89,76. Desconto R$ 27,78. Total R$ 61,98.

### Caso 6 — 200 ml e 300 ml

Pastel de cadastro R$ 10,00 × 2. Total do pedido R$ 36,00, com a sobra de R$ 16,00 numa linha auxiliar. Residual R$ 16,00. Copo 200 ml a R$ 8,00. Copo 300 ml a R$ 12,00. Copo 500 ml inativo.

- Só 200 ml: 2 × R$ 8,00 = R$ 16,00. Desconto R$ 0,00. Total R$ 36,00.
- Só 300 ml: 2 × R$ 12,00 = R$ 24,00. Desconto R$ 8,00, o excedente sobre R$ 16,00. Total R$ 36,00.
- Os dois ativos: a busca fica no exato de 2 × 200 ml. Desconto R$ 0,00. O fingerprint é o mesmo do cenário só com 200 ml.

### Caso 7 — reabrir e conferir de novo

Segunda chamada sobre o pedido do caso 1: desconto R$ 45,78 nos dois retornos, fingerprints iguais, itens iguais.

### Caso 8 — recompor sem duplicar

Antes e depois das duas chamadas, `pedidos_itens` tinha uma linha: #747, quantidade 2, subtotal R$ 61,98. Os copos não foram inseridos no pedido. O desconto do pedido permaneceu o zero gravado na massa. O desconto de R$ 45,78 está só no payload.

## 7. Plano de correção

Nenhuma sprint abaixo foi executada. A busca `buscarComposicao`, a tolerância de 20% e o fechamento fiscal ficam de fora até uma sprint própria, com a causa e o impacto aprovados.

### Sprint A — contrato da Venda por Valor

Confirmar com o produto, antes de código, a identidade desejada:

- o valor informado continua sendo o total líquido;
- a linha do pastel deixa de receber esse valor inteiro quando ainda vão entrar copos;
- o desconto técnico passa a ser só o excedente da combinação sobre o residual (R$ 1,78 no pedido #68), e R$ 0,00 quando a combinação for exata;
- a soma das linhas emitidas menos esse excedente fecha o valor informado.

Impacto a mostrar na sprint, ainda sem implementar: os copos continuam na composição, e o documento deixa de nascer com bruto R$ 107,76 e desconto R$ 45,78. O líquido permanece R$ 61,98. A forma de partir R$ 61,98 entre pastel e copos muda o valor unitário fiscal de cada linha. Essa escolha precisa estar escrita antes da alteração.

### Sprint B — uma função, só na Venda por Valor

Ajustar o passo da massa monetária, ou o subtotal comercial que a Venda por Valor entrega ao motor, para a identidade da sprint A. A composição normal da linha de R$ 43,98 deve continuar produzindo desconto R$ 27,78 enquanto o contrato dela não mudar. Não alterar volumes, objetivo `MINIMO`, nem a tolerância de dinheiro.

Critério de aceite no banco temporário: o caso 1 deixa de ter desconto R$ 45,78; o caso 3 da Venda por Valor deixa de ter desconto igual ao copo quando a combinação é exata; o caso 5 permanece em R$ 27,78.

### Sprint C — as duas telas no mesmo payload

A conferência e o `#descontoPdv` já leem o mesmo campo. A sprint B não pode criar um segundo desconto. O teste da sprint precisa comparar o `desconto` da resposta da Venda por Valor com o `desconto` que o handoff grava. Reabrir o pedido sem `venda_id` precisa repetir fingerprint, itens e desconto, com uma linha só em `pedidos_itens`.

Fora destas sprints: regra de 20%, classificação do dinheiro, estoque fiscal e não fiscal, fechamento, emissor e NFC-e mista.
