# PDV-MULTIEMPRESA-04 — Capacidade por item e tipo de saldo

**Data:** 2026-10-26  
**Módulo:** PDV oficial `/pdv` (motor de capacidade MULTIEMPRESA)  
**Estado final:** **CONCLUÍDA**

## 1. Estado antes da sprint (pré-verificação)

| Área | Situação encontrada |
|---|---|
| Ficha técnica | Já corrigida (worktree): insumos usam `saldo_fiscal + saldo_nao_fiscal` (`lerDisponivelFichaInsumo`), alinhado ao consumo real — coberta por `tests/pdv/pdv-sel-03-capacidade-ficha-saldo.test.js` |
| Itens sem ficha | Um único `tipoSaldo` **da operação** (`emitir_fiscal` / `venda_fiscal`) aplicado a **todos** os itens |
| Preview PDV | Envia só `itens[{produto_id,quantidade,unidade}]` + `emitir_fiscal` — sem tipo por item |
| Contrato de finalização | Já pode carregar `quantidade_fiscal` / `quantidade_nao_fiscal` / `item_fiscal` (Motor F×NF) |
| Lacuna real | Carrinho com requisitos **heterogêneos** por item não era avaliável; capacidade não lia campos opcionais confiáveis do contrato |

**Não duplicada** a correção de ficha: preservada e reutilizada.

## 2. Correções existentes reutilizadas

- `lerDisponivelFichaInsumo` + `consultarDisponivelSeguro` (SEL-03 / capacidade ficha).
- Política matriz → filiais `id ASC`, sem soma entre CNPJs (`selecionarEmpresaCapacidade`).
- `resolverTipoSaldoParaCapacidade` no preview/finalização (tipo operacional padrão).
- Bloqueios `NENHUMA_EMPRESA_*`, caixa na finalização, `EMPRESA_SIMPLES`.

## 3. Implementação (menor alteração)

### Regras aplicadas

1. **Por item sem ficha**
   - Se o item traz `quantidade_fiscal` e/ou `quantidade_nao_fiscal` → modo **SPLIT**: exige ambos os buckets na **mesma** empresa.
   - Senão, se traz `tipo_saldo` / `tipoSaldo` → usa esse tipo.
   - Senão → herda o `tipoSaldo` da operação (compatível R08 / SEL-01).
2. **Com ficha** → continua total F+NF por insumo (sem alteração de regra).
3. Gargalos distinguem `ESTOQUE_INSUFICIENTE_FISCAL` / `ESTOQUE_INSUFICIENTE_NAO_FISCAL` / `INSUMO_INSUFICIENTE`.
4. Hash do carrinho incorpora tipo/split por item (invalida snapshot se o requisito mudar).
5. Consulta somente leitura — **não** debita estoque.

### Lacuna documentada (sem inventar regra / sem mudar contrato público)

`item_fiscal` no catálogo/PDV indica natureza do SKU para NF, **não** o bucket de baixa com segurança suficiente. **Não** foi usado sozinho para escolher saldo.  
O preview atual do PDV ainda não envia `tipo_saldo` nem quantidades F/NF por item; a capacidade heterogênea fica ativa quando o contrato (finalização / cliente API / testes) já traz esses campos. UI nova ficou fora do escopo.

## 4. Arquivos alterados

| Arquivo | Ação |
|---|---|
| `backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa.js` | `resolverRequisitoEstoqueItem`, normalização/hash, avaliação por item / split |
| `backend/services/vendas/SelecaoEmpresaVendaPdvService.js` | `extrairItensCarrinho` propaga campos opcionais existentes |
| `tests/pdv/pdv-multiempresa-04-capacidade-por-item.test.js` | Novo |
| `tests/pdv/pdv-sel-03-capacidade-ficha-saldo.test.js` | Aceita novo código de gargalo fiscal |
| `docs/arquitetura/PDV-MULTIEMPRESA-04-RELATORIO.md` | Este relatório |

`selecionarEmpresaCapacidade.js` — inspecionado; sem mudança necessária nesta sprint.

## 5. Testes executados (sequenciais)

```text
node --test tests/pdv/pdv-multiempresa-04-capacidade-por-item.test.js
→ 10 pass / 0 fail

node --test tests/pdv/pdv-sel-03-capacidade-ficha-saldo.test.js
→ 10 pass / 0 fail

node --test tests/muv/muv-cap-01-capacidade-selecao.test.js
→ 10 pass / 0 fail

node --test tests/pdv/pdv-sel-01-selecao-empresa.test.js
→ 18 pass / 0 fail
```

Cenários cobertos no teste novo: item fiscal; item não fiscal; misto OK; misto bloqueado sem somar CNPJs; split F+NF na linha; ficha; não-soma; hash; sem débito na consulta.

## 6. Isolamento

- SQLite `:memory:` nos testes direcionados.
- Sem `CDS_ALLOW_OFFICIAL_DB`, sem banco oficial/cliente, sem SEFAZ, sem vendas reais.

## 7. Limitações remanescentes

1. Preview PDV sem `tipo_saldo`/quantidades por item → carrinho heterogêneo na UI continua avaliado pelo tipo operacional único até o payload enriquecer (escopo UI fora desta sprint).
2. `item_fiscal` não mapeia automaticamente para bucket de estoque (decisão de negócio / contrato).
3. E2E SEL-02 não reexecutado nesta entrega (suíte mais ampla; fora do pedido de testes direcionados).

## 8. Critérios de aceite

| Critério | Status |
|---|---|
| Pré-verificação do estado real | Atendido |
| Capacidade por item respeita saldos quando o contrato informa | Atendido |
| Sem aprovação com estoque de outro CNPJ | Atendido |
| Testes direcionados passando | Atendido |
| Contratos de seleção/revalidação preservados | Atendido |
| Escopo limitado | Atendido |

**Estado final: CONCLUÍDA**
