# PDV-MULTIEMPRESA-07 — Compatibilidade do saldo com o tipo da venda

**Data:** 2026-10-26  
**Módulo:** PDV oficial `/pdv` + motor de capacidade MUV  
**Tipo:** Auditoria e correção mínima (quando comprovada)  
**Estado final:** **INTERROMPIDA — decisão arquitetural necessária** (sem alteração do motor fiscal)

## 1. Objetivo da sprint

Garantir que seletor e finalização respeitem buckets compatíveis com o tipo da operação:

- venda fiscal → somente `saldo_fiscal`;
- venda não fiscal → somente `saldo_nao_fiscal`;
- sem usar `estoque_atual` total como substituto;
- sem soma entre CNPJs / sem divisão da venda.

## 2. Pré-verificação — regra de baixa encontrada

### 2.1 Origem autoritativa de `emitir_fiscal` / `venda_fiscal`

| Camada | Função | Precedência |
|---|---|---|
| Finalização | `VendaPagamentoService.resolverVendaFiscalParaMotor` | `venda_fiscal` se presente; senão `emitir_fiscal` |
| Seletor | `SelecaoEmpresaVendaPdvService.resolverTipoSaldoParaCapacidade` | **Idêntica** |
| Motor F×NF | `distribuirQuantidadeVenda(..., vendaFiscal)` | `parseVendaFiscalFlag(vendaFiscal)` → prioriza fiscal ou não fiscal |

Preview PDV (`pdv.js`): envia `emitir_fiscal` (= `pdvEmitirFiscalNaVenda === true`) e, após M05, também `venda_fiscal` alinhado.

### 2.2 Baixa oficial — produtos **sem** ficha (`distribuidorEstoqueVenda.js`)

`obterFaixaQuantidadeFiscal` / `distribuirQuantidadeVenda`:

1. Sucesso se **total** `saldo_fiscal + saldo_nao_fiscal >= quantidade`.
2. `vendaFiscal=true`: consome **até** o fiscal (`quantidadeFiscalMax`), resto no não fiscal.
3. `vendaFiscal=false`: consome **mínimo** fiscal necessário (`quantidadeFiscalMin` = o que não cabe no NF), resto no não fiscal.

**Consequência comprovada:**

| Cenário | Motor F×NF | Observação |
|---|---|---|
| Só NF + venda “fiscal” | **Aprova** (qF=0, qNF=qty) | Usa saldo exclusivamente não fiscal |
| Só F + venda “não fiscal” | **Aprova** (qF=qty, qNF=0) | Usa saldo exclusivamente fiscal |
| F=3 NF=3 qty=5 fiscal | **Aprova** (3F+2NF) | Cruza buckets |

Débito físico (`debitoEstoqueVendaViaPorta`) apenas aplica as `quantidade_fiscal` / `quantidade_nao_fiscal` já produzidas pelo motor — **não** revalida exclusividade de bucket.

### 2.3 Baixa / validação — **ficha técnica**

`FichaTecnicaConsumoService.validarEstoqueAgregado`: disponível = `saldo_fiscal + saldo_nao_fiscal`; débito fiscal primeiro, resto NF.  
Capacidade (`lerDisponivelFichaInsumo`): **mesma base total F+NF**. Alinhadas — preservar.

### 2.4 Capacidade do seletor (estado atual — M04/SEL-01)

Para item **sem** ficha, modo `UNICO`:

- exige a quantidade **inteira** no bucket da operação (`tipoSaldo` da operação ou `tipo_saldo` do item);
- modo `SPLIT` quando o contrato traz `quantidade_fiscal` / `quantidade_nao_fiscal`;
- **não** usa `item_fiscal` sozinho;
- **não** usa `estoque_atual` total;
- **não** soma CNPJs.

Isto **já corresponde** à regra de negócio solicitada nesta sprint (§2 do briefing).

## 3. Comparação capacidade × baixa

| Aspecto | Capacidade (seletor / revalidação) | Baixa Motor F×NF | Regra solicitada M07 |
|---|---|---|---|
| Bucket exclusivo por tipo de venda | Sim | Não (prioridade + total) | Sim |
| Pode aprovar fiscal só com NF | Não | Sim | Não |
| Pode aprovar não fiscal só com F | Não | Sim | Não |
| Ambos saldos, qty > bucket preferido | Bloqueia | Aprova com split | Bloqueia |
| Ficha (insumos) | Total F+NF | Total F+NF | Preservar contrato vigente |
| Soma entre CNPJs | Não | N/A (empresa da venda) | Não |

**Divergência comprovada:** a regra solicitada e a capacidade atual são **mais estritas** que a baixa oficial do Motor F×NF.

No caminho MULTIEMPRESA do PDV, a revalidação de capacidade na finalização (`aplicarSelecaoEmpresaNaVendaPdv`) **bloqueia antes** do motor — na prática o seletor já impede os casos exclusivos cruzados. Porém a finalização “oficial” do motor, se invocada sem esse gate, ainda permite cruzamento.

## 4. Decisão de implementação

Conforme §4 do briefing:

> Se a regra de baixa real divergir da regra solicitada, documentar a divergência e **interromper** antes de alterar o motor fiscal.

**Ações tomadas:**

- Nenhuma alteração em `distribuidorEstoqueVenda.js`, motor fiscal, schema ou contratos públicos.
- Nenhuma alteração em `ServicoCapacidadeCarrinhoEmpresa.js` / `SelecaoEmpresaVendaPdvService.js` — já alinhados à regra solicitada; afrouxar capacidade para espelhar o motor **violaria** §2.
- Testes isolados criados para travar o comportamento do seletor e **evidenciar** a divergência do motor (sem “consertar” removendo bloqueios).

**Decisão pendente do Tech Lead (escolha mutuamente exclusiva):**

| Opção | Efeito |
|---|---|
| **A)** Endurecer o Motor F×NF para buckets exclusivos (igual §2) | Alinha finalização à regra solicitada; impacto amplo em PDV/outros canais que dependem do split por prioridade |
| **B)** Manter Motor como está e tratar §2 só no seletor MULTIEMPRESA | Status quo documentado; finalização fora do gate continua permissiva |
| **C)** Afrouxar capacidade para prioridade+total (igual motor) | Alinha seletor ao motor; **contradiz** a regra obrigatória desta sprint |

## 5. Arquivos

| Arquivo | Ação |
|---|---|
| `tests/pdv/pdv-multiempresa-07-compatibilidade-saldo.test.js` | **Criado** |
| `docs/arquitetura/PDV-MULTIEMPRESA-07-RELATORIO.md` | **Criado** |
| Produção (capacidade / seletor / motor) | **Sem alteração** |

## 6. Testes executados

```text
node --test tests/pdv/pdv-multiempresa-07-compatibilidade-saldo.test.js
→ 12 pass / 0 fail
```

| # | Cenário | Resultado |
|---|---|---|
| — | Precedência `venda_fiscal` / `emitir_fiscal` | PASS |
| 1 | Só fiscal + venda fiscal | PASS (aprova) |
| 2 | Só fiscal + venda não fiscal | PASS (bloqueio seletor; motor ainda aprovaria — evidência) |
| 3 | Só NF + venda não fiscal | PASS (aprova) |
| 4 | Só NF + venda fiscal | PASS (bloqueio seletor; motor ainda aprovaria — evidência) |
| 5 | Ambos saldos; não usa total | PASS (bloqueia qty > bucket; motor faria split) |
| 6 | Qty > bucket exigido | PASS |
| 7 | Carrinho misto `tipo_saldo` | PASS |
| 8 | Ficha total F+NF | PASS |
| 9 | Sem soma CNPJs | PASS |
| 10 | Revalidação após baixa sintética | PASS |
| — | `item_fiscal` isolado não escolhe bucket | PASS |

Regressões direcionadas (sequenciais):

```text
node --test tests/pdv/pdv-multiempresa-04-capacidade-por-item.test.js  → 10 pass / 0 fail
node --test tests/pdv/pdv-sel-01-selecao-empresa.test.js              → 18 pass / 0 fail
node --test tests/pdv/pdv-multiempresa-05-preview-itens.test.js       →  8 pass / 0 fail
```

Isolamento: `:memory:`, sem `CDS_ALLOW_OFFICIAL_DB`, sem SEFAZ, sem vendas reais.

## 7. Limitações restantes

1. Motor F×NF continua permitindo cruzamento de buckets — **fora do escopo seguro** desta sprint.
2. Canais que finalizam **sem** o gate `aplicarSelecaoEmpresaNaVendaPdv` não herdam a regra exclusiva do seletor.
3. UX: mensagem 409 já descreve gargalo por bucket; não foi alterada.
4. Estoque zerado em `estoque_empresa` (sem registro por empresa) continua lido como 0 — regra de porta pública, não desta sprint.

## 8. Encerramento

Critério de CONCLUÍDA (“seletor **e** finalização respeitam buckets compatíveis”) **não** pode ser marcado: a finalização oficial (Motor F×NF) diverge da regra solicitada, e o briefing proíbe alterar o motor fiscal sem decisão.

**Estado: INTERROMPIDA** — evidências acima; aguardando Tech Lead (opções A/B/C na §4).  
Não iniciada outra sprint automaticamente.
