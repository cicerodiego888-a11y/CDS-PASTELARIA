# Estorno da ficha técnica no cancelamento — Pastelaria (Sprint 03.07)

**Produção alterada:** sim (estoque de insumos no cancelamento). **Fora:** devolução proporcional (03.08), cubas/açaí, MUV, financeiro extra, NFC-e, Central, PDV Universal.

---

## 1. Fluxo anterior

Cancelamento (`PUT /api/vendas/:id/cancelar` e `POST /api/vendas/cancelar/:id`) já devolvia o **produto comercial** (`devolverEstoqueItensVenda` → `creditarEstoqueItemVenda`) na `BEGIN IMMEDIATE`. O consumo de insumos (`venda_ficha_consumo`) **não** era lido. A ficha vigente não era consultada no cancelamento (correto), mas o estoque do insumo ficava baixado.

---

## 2. Ponto de integração

Único ponto de domínio: `estornarConsumoFichaTecnicaDaVenda` em `FichaTecnicaConsumoService`.

Único ponto no cancelamento: `devolverEstoqueEEstornarFichaDaVenda` em `VendaCancelamentoService` (PUT e POST). Ordem na transação local:

1. ownership (`exigirOperacaoReversaoDaVenda`) — **antes** do BEGIN  
2. NFC-e autorizada (`cancelarNfceAutorizadaVenda`) — **antes** do BEGIN (pré-existente)  
3. `BEGIN IMMEDIATE`  
4. crédito do item comercial  
5. estorno do snapshot da ficha  
6. recebimentos / `UPDATE vendas` cancelada / financeiro existente  
7. `COMMIT` ou `ROLLBACK`

Não há rota paralela de estorno.

---

## 3. Origem do snapshot

`venda_ficha_consumo_itens`: `quantidade` (já na unidade de estoque), `unidade`, `insumo_id`, `empresa_id`, `produto_id`. Agregação por `insumo_id`. **Não** chama `FichaTecnicaService.obterPorProdutoId` nem `montarLinhasConsumo`.

---

## 4. Empresa

Cabeçalho `venda_ficha_consumo.empresa_id` deve coincidir com `vendas.empresa_id` passado via `montarOpcoesRetornoEstoqueDaVenda` (`exigirEmpresa: true`). Divergência → `FICHA_CONSUMO_EMPRESA_DIVERGENTE`. Sem `req.empresaId` como dono, sem empresa 1, sem operacional, sem COMPAT.

---

## 5. Mecanismo de estoque

`creditarEstoqueItemVenda` (`origem: estorno_ficha_tecnica_cancelamento`). Quantidade do snapshot creditada em saldo fiscal (consumo 03.04 debitava fiscal primeiro; split F/NF não estava persistido no snapshot — ver riscos).

---

## 6. Transação

Estorno ocorre **dentro** da `BEGIN IMMEDIATE` já existente. Falha no crédito de qualquer insumo → `ROLLBACK` (comercial + insumos + status).

---

## 7. Idempotência

Coluna `venda_ficha_consumo.estornado_em`. Segunda chamada: `ja_estornado: true`, sem novo crédito. PUT recusa se `status !== concluida`; POST recusa se `cancelada === 1` — ambos **antes** do estorno.

---

## 8. Cancelamento

Status e financeiro/caixa/NFC-e **não** foram redesenhados. Só entrou o estorno de insumos no mesmo BEGIN após o retorno comercial.

---

## 9. Rollback

T06/T19: falha forçada no segundo insumo (ou no crédito) + `ROLLBACK` → estoque e `estornado_em` e status da venda preservados.

---

## 10. Multiempresa

Cancelar venda A (empresa A) restaura só estoque A. Empresa B inalterada.

---

## 11. Cross-company

Caller B + venda A → `VENDA_NAO_ENCONTRADA` antes de mutação. Estorno com `empresaId` B e cabeçalho A → bloqueio, sem crédito.

---

## 12. Ficha alterada

Estorno usa `quantidade` gravada na venda (ex.: 0,2 kg), nunca a ficha atual (ex.: 500 g).

---

## 13. Venda sem ficha

Sem cabeçalho → `{ sem_consumo: true }`. Cancelamento segue; nenhum INSERT de consumo.

---

## 14. Testes

`tests/pastelaria/estorno-ficha-cancelamento-03-07.test.js` (T01–T20).

---

## 15. Regressões

03.01–03.05, 03.06 (T08/T17/T18 alinhados ao estorno no cancel), 05.40, 05.53–05.56, 05.59, 05.64, 05.70, 05.72, 05.74–05.77, 05.80; crédito cancel/dev (contagem PUT/POST via wrapper).

---

## 16. Riscos restantes

1. **Devolução (03.08):** ainda não estorna insumos.  
2. **Split F/NF** do consumo não está no snapshot; estorno total credita a quantidade em fiscal.  
3. NFC-e de cancelamento continua **fora** do BEGIN local (P2 da 03.06).  
4. Dual-write `produtos` vs `estoque_empresa` na porta de saldo (pré-existente).
