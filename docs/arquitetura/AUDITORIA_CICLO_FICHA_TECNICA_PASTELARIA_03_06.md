# Auditoria do ciclo da ficha técnica — Pastelaria (Sprint 03.06)

**Tipo:** auditoria. **Produção:** não alterada. **Escopo:** Pastelaria / CDS. Fora: Açaíteria, cubas, iFood, Alô Chefia, PDV Universal.

Confirma pelo código a pendência da 03.05: **cancelamento e devolução não estornam o consumo da ficha.**

---

## 1. Venda — onde o consumo nasce

Fluxo oficial:

```
PDV Normal (`frontend/pdv/js/pdv.js`)
  → POST /api/vendas  (`rotas/vendas.js` + `validarCaixaSeOrigemPdv`)
  → VendaApplicationService.criarVenda
  → VendaPagamentoService.criarVenda
       BEGIN IMMEDIATE
       INSERT venda + itens
       reduzirEstoqueDistribuido (produto comercial)
       aposBaixaItensDaVenda
         → consumirFichaTecnicaDaVendaCb  (empresaId = vendas.empresa_id)
       COMMIT / ROLLBACK
```

Respostas:

| # | Pergunta | Resposta atual |
|---|----------|----------------|
| 1 | Onde a ficha é identificada? | `FichaTecnicaService.obterPorProdutoId(produtoId)` em `montarLinhasConsumo` |
| 2 | Quantidade da ficha? | `qtdVenda × componente.quantidade` (`quantidade_ficha`) |
| 3 | Conversão? | `MotorUnidadesMedida.converterQuantidadeEntreUnidades` (ficha → unidade do cadastro do insumo) |
| 4 | Onde o insumo é baixado? | `debitarEstoqueItemVenda` com `exigirEmpresa: true`, `origem: 'consumo_ficha_tecnica'` |
| 5 | Onde o consumo é registrado? | INSERT `venda_ficha_consumo` + `venda_ficha_consumo_itens` após os débitos |
| 6 | Tabela? | Cabeçalho + itens (schema `vendaFichaConsumoSchema.js`; `database.js` só garante o schema) |
| 7 | Origem? | `venda_id`, `produto_id` (comercial), `insumo_id`. Sem `venda_item_id`. Sem `ficha_id` |
| 8 | `empresa_id`? | Sim, no cabeçalho e em cada item (= `vendas.empresa_id` passado pelo pagamento) |
| 9 | Por item ou por venda? | Cabeçalho **por venda** (`venda_id UNIQUE`). Linhas **por produto comercial × insumo** (não pelo `vendas_itens.id`) |
| 10 | Quantidade original? | `quantidade` = já convertida para estoque; `quantidade_ficha` = bruta na unidade da ficha |
| 11 | Unidade? | `unidade` (estoque) e `unidade_ficha` |
| 12 | Reversão exata? | **PARCIAL.** Snapshot de qtd/unidade/insumo/empresa/venda basta para **estorno total**. Falta marca de estorno, split F/NF persistido, e `venda_item_id` para proporcional por linha |

Idempotência da venda: se já existe cabeçalho, `ja_consumido: true` (não debita de novo).

---

## 2. Schema `venda_ficha_consumo`

Criado em `vendaFichaConsumoSchema.js` (`CREATE TABLE IF NOT EXISTS`). Sem migration versionada extra. Sem índices além de `venda_id UNIQUE` no cabeçalho. FKs declaradas; SQLite pode estar com FK off.

**Cabeçalho:** `id`, `venda_id UNIQUE`, `empresa_id`, `created_at`. Sem status, sem `estornado_em`.

**Itens:** `id`, `venda_id`, `empresa_id`, `produto_id`, `insumo_id`, `quantidade`, `unidade`, `quantidade_ficha`, `unidade_ficha`, `created_at`.

Ausente: `ficha_id`, `venda_item_id`, `quantidade_fiscal` / `nao_fiscal`, `status`.

**Suficiência para estorno determinístico: PARCIAL.**

---

## 3. Cancelamento (todos os fluxos)

| Endpoint | Serviço | Função |
|----------|---------|--------|
| `PUT /api/vendas/:id/cancelar` | `VendaCancelamentoService` | `cancelarVendaPut` |
| `POST /api/vendas/cancelar/:id` | idem | `cancelarVendaPost` |

Middleware: `anexarEmpresaVenda` + `validarCaixaAbertoCancelamentoVenda`.

Ownership: `exigirOperacaoReversaoDaVenda(venda, req.empresaId)` — empresa persistida da venda vs contexto. Cruzado → `VENDA_NAO_ENCONTRADA` (404). Venda sem `empresa_id` → `EMPRESA_OWNERSHIP_REQUIRED`.

Estoque: `devolverEstoqueItensVenda` → `creditarEstoqueItemVenda` com `montarOpcoesRetornoEstoqueDaVenda(venda)` → **`vendas.empresa_id`**, `exigirEmpresa: true`. Credita o **produto comercial**, não o insumo.

Status: `cancelada` / `cancelada=1`. PUT exige `status === 'concluida'`. POST recusa se `cancelada === 1`.

Financeiro: `cancelarFinanceiroVenda`. PUT ainda insere linha `financeiro` `estorno_venda`. POST grava `vendas_canceladas` e não tem o mesmo INSERT extra.

Fiscal: `cancelarNfceAutorizadaVenda` **antes** do `BEGIN IMMEDIATE` local.

**`venda_ficha_consumo` não é lida nem atualizada. Insumos não são creditados.**

Cancelamento **parcial de itens: não existe.**

---

## 4. Devolução

Único fluxo de estoque/financeiro: `POST /api/vendas/:id/devolver` → `devolverParcial` (+ senha admin + caixa).

Rotas `nfe-devolucao` são **fiscais** (NFC-e/NFe de devolução), isoladas do consumo da ficha.

1. Quantidade: `vendas_devolucoes.quantidade` (+ F/NF).  
2. Parcial: **sim** (por `venda_item_id`).  
3. Total: soma de parciais até a quantidade vendida.  
4. Persistência: `vendas_devolucoes` (sem `empresa_id` na tabela).  
5. Vínculo item: `venda_item_id`.  
6. Vínculo ficha: **não**.  
7. Estorno de insumo: **não**.

Impede `quantidade > disponível` (já devolvido somado). Venda cancelada não recebe devolução.

---

## 5. Estoque — o que reutilizar

| Função | Uso |
|--------|-----|
| `debitarEstoqueItemVenda` | Baixa venda e consumo de ficha |
| `creditarEstoqueItemVenda` | Cancel/devolução do **item vendido** — **reutilizar** para insumos |
| `montarOpcoesRetornoEstoqueDaVenda` | Empresa = `vendas.empresa_id` |

Não criar writer novo. Conversão na reversão total: **não reconverter a ficha vigente**; usar `venda_ficha_consumo_itens.quantidade` + `unidade`.

---

## 6. Multiempresa e ownership

Consumo: `exigirEmpresaDaOperacao({ empresaId })` com o id já persistido da venda. Sem `req`, sem empresa 1, sem COALESCE, sem operacional.

Cancel/devolução: estoque pela venda; autorização pelo `req.empresaId` (não substitui o dono do estoque).

Caller B em venda A: bloqueado hoje. Manter.

---

## 7. Ficha alterada depois da venda

O snapshot **não** é atualizado. Teste T12: 80 G na venda; ficha depois 500 G; linhas de consumo continuam 80 G / kg convertido. Estorno futuro deve usar o snapshot, nunca `obterPorProdutoId` atual.

---

## 8. Conversão

`80 G` com insumo em `KG` → débito `0,08 KG` (`round3`). Histórico guarda ambos os lados. Reversão total: creditar `quantidade` na `unidade` (estoque), sem nova conversão. Reversão parcial: fração de `quantidade` (P1 se faltar `venda_item_id`).

Débito F/NF na venda: fiscal primeiro, resto não fiscal. **Esse split não está nas linhas de consumo** — risco P1 ao creditar o bucket errado.

---

## 9. Vários itens

Produto com ficha gera linhas; produto sem ficha não. Cabeçalho só se houver pelo menos uma linha. Dois comerciais com ficha: linhas distinguíveis por `produto_id`. Duas linhas do **mesmo** `produto_id` na mesma venda: ambiguidade para proporcional (GAP P1).

---

## 10. Duplo processamento

| Evento | Situação |
|--------|----------|
| Consumo duas vezes na mesma venda | **PROTEGIDO** (`UNIQUE venda_id` + early return) |
| Cancelar duas vezes | **PROTEGIDO** (status / `cancelada`) |
| Devolver acima do vendido | **PROTEGIDO** |
| Devolver de novo o restante | **PROTEGIDO** (soma `vendas_devolucoes`) |
| Estorno de ficha duas vezes | **NÃO PROTEGIDO** (função inexistente; sem flag) |

---

## 11. Transação e rollback

Cancel e devolução: `BEGIN IMMEDIATE` no `db` global; estoque comercial + status/financeiro no mesmo bloco; erro → `ROLLBACK`.

Estorno de ficha **não entra**. Hipótese “crédito comercial OK + estorno ficha FALHA” **não ocorre hoje** (ficha não é chamada). Implementação futura: **mesmo BEGIN**, senão GAP de atomicidade.

NFC-e cancelada **fora** da transação local: risco pré-existente (fiscal vs venda), fora do estoque da ficha.

---

## 12. Financeiro, caixa, fiscal

- **Financeiro:** já cancela/recalcula na reversão. Estorno de ficha **não** deve inserir nova despesa.  
- **Caixa:** valida sessão aberta da empresa; audit `sessao_id`; sem INSERT de movimento de caixa no cancel. Não criar sangria por ficha.  
- **Fiscal:** NFC-e no cancel; NFe de devolução em rotas próprias. Estorno de insumo = **somente estoque**.

---

## 13. PDV

Oficial: PDV Normal → POST `/api/vendas` → Application → Pagamento. Universal: **CONGELADO**; consumo não depende dele.

---

## 14. Matriz de fluxos

| Fluxo | Situação atual | Empresa | Estoque | Ficha |
|-------|----------------|---------|---------|-------|
| Venda | Consome se ficha ativa | `vendas.empresa_id` | Debita comercial + insumos | Snapshot gravado |
| Cancelamento | Total da venda | Venda + contexto | Credita **comercial** | **Não toca** |
| Devolução parcial | Por item | Venda + contexto | Credita **comercial** proporcional | **Não toca** |
| Devolução “total” | Soma de parciais | Idem | Idem | **Não toca** |
| Cancelamento parcial | **Não existe** | — | — | — |

## 15. GAPS

| GAP | Evidência | Severidade | Solução sugerida |
|-----|-----------|------------|------------------|
| Cancelamento não estorna insumos | `VendaCancelamentoService` sem `venda_ficha_consumo`; T08 saldo do insumo inalterado após crédito comercial | **P0** | Após crédito comercial, no mesmo `BEGIN`, creditar `quantidade` por insumo via `creditarEstoqueItemVenda` + marcar estorno |
| Devolução não estorna insumos | `VendaDevolucaoService` sem ficha; T09 | **P0** | Proporcional `qtd_devolvida/qtd_vendida` sobre snapshot do `produto_id` (ou `venda_item_id` se schema evoluir) |
| Sem flag de estorno | Schema sem `estornado_*` | **P0** (junto da impl.) | `estornado_em` no cabeçalho (cancel total) e/ou tabela/colunas por item |
| Sem `venda_item_id` | DDL itens | **P1** | Necessário se duas linhas iguais do mesmo produto; senão agregar por `produto_id` |
| Split F/NF do consumo não persistido | Débito usa saldo fiscal primeiro; colunas ausentes | **P1** | Persistir na impl. ou política explícita de crédito (espelhar débito ou SNF-first documentado) |
| Sem `ficha_id` | DDL | **P2** | Auditoria; não bloqueia estorno |
| PUT vs POST cancel financeiro diferente | INSERT extra só no PUT | **P2** | Não misturar com ficha |
| NFC-e fora do BEGIN | `cancelarNfceAutorizadaVenda` antes | **P2** (pré-existente) | Isolar ficha do fiscal |

---

## 16. O que reutilizar vs alterar (próxima implementação)

**Reutilizar:** `creditarEstoqueItemVenda`, `montarOpcoesRetornoEstoqueDaVenda`, snapshot `quantidade`/`unidade`/`insumo_id`/`empresa_id`, `exigirOperacaoReversaoDaVenda`, transação já existente.

**Alterar (não nesta sprint):** `FichaTecnicaConsumoService.js` (funções de estorno), `VendaCancelamentoService.js`, `VendaDevolucaoService.js`, possivelmente `vendaFichaConsumoSchema.js`.

**Não alterar:** DistDFe, MIIP, Central, PDV Universal, fiscal (além de não acoplar), financeiro extra, caixa.

**Schema:** recomendável coluna(s) de estorno para idempotência; `venda_item_id` opcional (P1).

**Menor implementação segura:** **03.07** — estorno **total** no cancelamento (somar linhas da venda, creditar insumos, marcar cabeçalho). Depois proporcional na devolução.

---

## 17. Respostas do critério de conclusão

1. Nasce em `consumirFichaTecnicaDaVenda` após baixa dos itens, na transação da venda.  
2. `venda_ficha_consumo` + `_itens`.  
3. `vendas.empresa_id`.  
4. `debitarEstoqueItemVenda` / porta F×NF / `estoque_empresa`.  
5. Crédito do comercial + status + financeiro; ficha intacta.  
6. `devolverParcial` + `vendas_devolucoes`; ficha intacta.  
7. Sim, parcial por item.  
8. Histórico **PARCIAL** (bom para total; frágil para parcial/F-NF/duplo).  
9. `venda_ficha_consumo_itens.quantidade` (unidade de estoque).  
10. `unidade` do item de consumo.  
11. Flag/tabela de estorno + UNIQUE já no consumo da venda.  
12. Dentro de `cancelarVendaPut`/`Post` e `devolverParcial`, após ou junto ao crédito comercial.  
13. O `BEGIN IMMEDIATE` que já envolve o crédito do item.  
14. Consumo service + cancel + devolução (+ schema de flag).  
15. Flag de estorno: **sim, recomendado**.  
16. Sim, registro de estorno ou colunas.  
17. Porta de crédito + snapshot.  
18. Duplo crédito de insumo; proporcional errado; F vs NF; financeiro duplicado se alguém inserir lançamento.  
19. Cancelamento total primeiro.  
20. Sprint **03.07** — implementação do estorno (cancelamento; devolução na mesma ou 03.08).
