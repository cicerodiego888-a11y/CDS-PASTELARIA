# Estorno proporcional da ficha técnica na devolução — Pastelaria (Sprint 03.08)

**Produção alterada:** sim (estoque de insumos na devolução parcial). **Fora:** cubas/açaí, MUV, Central, PDV Universal, NFC-e/NFe de devolução, financeiro extra.

Arredondamento: `round3` (3 casas), o mesmo do consumo 03.04 e do cancelamento 03.07.

---

## 1. Fluxo de devolução encontrado

| Fluxo | Classificação | Papel |
|-------|---------------|--------|
| `POST /api/vendas/:id/devolver` → `devolverParcial` | **PRODUÇÃO** | Único fluxo de estoque/financeiro da devolução de venda |
| `devolverEstoqueParcialItem` / `devolverSaldosDistribuidos` | PRODUÇÃO | Crédito do **produto comercial** |
| Rotas `nfe-devolucao` / `emitir-nfe-devolucao` | PRODUÇÃO fiscal | Isoladas; **não** estornam ficha |
| `POST /api/compras/:id/devolver` | PRODUÇÃO compras | Fora do escopo (não é venda) |
| Testes 05.42 / 02.5 | TESTE | Ownership e porta de crédito |

Não há application service/repositório paralelo. Status da venda **não** muda para cancelada na devolução. Venda cancelada **não** recebe devolução (regra existente).

---

## 2. Ponto de integração

`devolverParcial`, na mesma `BEGIN IMMEDIATE`, após `INSERT vendas_devolucoes` e crédito comercial, chama `estornarConsumoFichaTecnicaDaDevolucao` (`FichaTecnicaConsumoService`). Sem rota nova.

---

## 3. Cálculo proporcional

`consumo_snapshot × (quantidade_devolvida / quantidade_vendida_do_produto)`  
`quantidade_vendida` = soma de `vendas_itens.quantidade` daquele `produto_id` na venda.

---

## 4–7. Snapshot, vendida, devolvida, limite

Fonte: `venda_ficha_consumo_itens` (não a ficha vigente).  
Teto: `estornado_acumulado <= snapshot` por `produto_id`+`insumo_id` (`venda_ficha_consumo_estornos`).

---

## 8. Idempotência

Identidade: `vendas_devolucoes.id`. Índice único `(venda_devolucao_id, insumo_id)`. Reexecução com o mesmo id → `ja_estornado`.

---

## 9–10. Sucessivas e total

3+2+5 de 10 unidades (1000 g) → 300+200+500. Devolução de 100% das unidades estorna 100% do snapshot, sem cancelamento.

---

## 11. Cancelamento + devolução

Venda cancelada não recebe devolução. Cancelamento 03.07 passa a creditar só o **restante** (snapshot − estornos de devolução) e marca `estornado_em`.

---

## 12–13. Empresa / multiempresa

`vendas.empresa_id` via `montarOpcoesRetornoEstoqueDaVenda` (`exigirEmpresa: true`). Devolver A não altera estoque B.

---

## 14. Cross-company

`exigirOperacaoReversaoDaVenda` antes do BEGIN. Estorno com empresa divergente → `FICHA_CONSUMO_EMPRESA_DIVERGENTE`.

---

## 15–16. Transação / rollback

Mesma `BEGIN IMMEDIATE`. Falha no crédito de qualquer insumo → `ROLLBACK` (devolução e estoque).

---

## 17–18. Unidades / múltiplos insumos

Unidade do snapshot (ex. 0,9 L). Cada insumo com a mesma fração, com teto individual.

---

## 19. Venda sem ficha

Sem cabeçalho → no-op. Sem INSERT de consumo.

---

## 20. Ficha alterada/inativa

Snapshot permanece. Inativar a ficha depois **não** impede o estorno. Crédito de estoque não exige insumo ativo no writer atual.

---

## 21–22. Testes / regressões

`tests/pastelaria/estorno-ficha-devolucao-03-08.test.js` (T01–T25). Regressões 03.01–03.07 e 05.40+.

---

## 23. Riscos restantes

Split F/NF do consumo não persistido (crédito proporcional em fiscal). NFC-e de devolução continua fluxo fiscal separado. Dual-write `produtos` vs `estoque_empresa`.
