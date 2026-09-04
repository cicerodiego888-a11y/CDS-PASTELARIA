# MAPA DE TRANSIÇÕES EMPRESARIAIS — Sprint 05.48

**Status:** auditoria (código de produção não alterado)  
**Data:** 2026-08-25  
**Cadeia:** 05.40 → 05.47

Invariante auditada:

```
EMPRESA DA OPERAÇÃO → ownership persistido → fonte de verdade
contexto atual apenas autoriza (nunca reatribui / inventa / troca)
```

Classificação: **A** consolidado · **B** load-by-id + check antes do efeito · **C** COMPAT/legado/global explícito · **D** risco de escrita sem dono ou mistura · **E** fora da cadeia PDV NFC-e.

---

## T01 EMPRESA → SESSÃO DE CAIXA — **A**

| | |
|--|--|
| Persistência | `caixa_sessoes.empresa_id` |
| SQL | `montarSqlSessaoAberta`: sem empresa → `CAIXA_EMPRESA_OBRIGATORIA`; sempre `AND empresa_id = ?` |
| Não faz | `FROM caixa_sessoes WHERE status = 'aberto' LIMIT 1` global |
| Dashboard | `CaixaProvider` (05.45) soma sessão filtrando `cs.empresa_id` |
| Residual | Totais de venda da sessão filtram a sessão, não `vendas.empresa_id` (proxy de sessão). Legado NULL na sessão = sessão ilegível. |

---

## T02 SESSÃO → VENDA — **A**

| | |
|--|--|
| Persistência | `vendas.empresa_id` = `exigirEmpresaDaOperacao(req)` |
| Sessão | `exigirCaixaCompativelComVenda` — divergente → `CAIXA_SESSAO_EMPRESA_DIVERGENTE` (não troca a empresa da venda) |
| INSERT | `VendaPagamentoService` grava `empresaIdVenda` |

---

## T03 VENDA → ESTOQUE — **A** (PDV/MUV/cancel/dev) · residual **C** no helper

| | |
|--|--|
| Criação PDV | `opcoesBaixaEstoque.empresaId` vem de `req.empresaId`, igual a `empresaIdVenda` após `exigirEmpresaDaOperacao` |
| MUV | `MaterializarOperacoesAtendimento` debita com `empresaId` da operação e `exigirEmpresa: true`; reserva divergente → `ATENDIMENTO_INVALIDO` |
| Cancel/dev | `montarOpcoesRetornoEstoqueDaVenda(venda)` — **somente** `vendas.empresa_id` |
| NULL | `resolverEmpresaDaVenda` → `EMPRESA_OWNERSHIP_REQUIRED` **antes** de estoque |
| Residual C | `montarOptsPortaDebitoVenda` ainda tem COMPAT `COMPAT_DEBITO_VENDA_PRE_MULTIEMPRESA` se chamado sem empresa (não é o caminho `criarVenda`) |

---

## T04 VENDA → LOTE / FEFO — **A**

| | |
|--|--|
| FEFO | `WHERE pl.empresa_id = ? AND pl.produto_id = ? ORDER BY data_validade ASC, id ASC` |
| Sem empresa | `EMPRESA_CONTEXT_REQUIRED` |
| Restauração | `UPDATE ... WHERE id = ? AND empresa_id = ?` |
| Cruzado | `LOTE_NAO_ENCONTRADO` (404) |
| Residual C | `gerarProximoLote` sequência nominal global `LT%` (código, não saldo) |

---

## T05 PEDIDO → RESERVA — **D** (com ramo A/C)

```
pedido (sem empresa_id)
        │
        ├─ caller passa empresaId → reserva.empresa_id persistido (05.47) → A/B
        ├─ Motor sem empresa → COMPAT_CERTIFICADA_PRE_MULTIEMPRESA → tracking NULL → C
        └─ ReservaRepair dryRun:false INSERT sem empresa_id → D
```

`pedidos` **não tem** coluna `empresa_id`. O mesmo pedido pode, em teoria, ser confirmado com empresas diferentes se o caller variar o contexto. Repair (`handlerCriarReserva`) insere `(pedido_id, produto_id, quantidade_fiscal, status)` sem `empresa_id`. Default do plano é dry-run; execução real (`dryRun: false`) é on-demand via `executarPlanoCorrecao`.

---

## T06 RESERVA → ESTOQUE — **A** (05.47) · **C** (COMPAT / Repair NULL)

| | |
|--|--|
| Criação pública | dual-write `estoque_empresa.reservado_*` da empresa persistida |
| Fórmula | `disponivel = saldo_empresa − reservado_empresa` |
| Liberar/consumir | usa `row.empresa_id` quando preenchido |
| NULL | `EMPRESA_OWNERSHIP_REQUIRED` na liberação empresarial; COMPAT no Motor/Repair |

---

## T07 VENDA → FINANCEIRO — **A** (escritores auditados)

INSERT com `empresa_id` da origem:

- `VendaPagamentoService` prazo e à vista → `empresaIdVenda`
- `VendaCancelamentoService` PUT estorno → `resolverEmpresaDaOrigemFinanceira({ venda })`
- `VendaFinanceiroService` estorno devolução → venda
- `MotorFinalizacaoVenda` / `MaterializarOperacoesAtendimento` → origem; divergência venda×caixa → `FINANCEIRO_EMPRESA_DIVERGENTE`
- `rotas/compras.js`, `rotas/financeiro.js`, `rotas/contas_receber.js`

Baixa: `SELECT ... WHERE id = ?` depois `exigirLancamentoDaEmpresa` (**B**) → UPDATE com `empresa_id`. NULL/cruzado = 404.

Residual: POST cancelamento **não** gera o INSERT de estorno do PUT (05.42). `contas_receber` na venda a prazo usa `req.empresaId || null` (coincide com `empresaIdVenda` no create, mas é escritor mais fraco). Recálculo de CR na devolução filtra `venda_id`, não `empresa_id`.

---

## T08 VENDA → NFC-e — **A** · DistDFe/NF-e 55 **E**

| | |
|--|--|
| Emissão/cancelamento NFC-e | `exigirEmpresaFiscalDaVenda` + `resolverCredenciaisNfceDaEmpresa` (`fonte === 'EMPRESA'`) |
| `nfce_notas` | **sem** `empresa_id` — ownership **indireto** via `venda_id` → `vendas.empresa_id` |
| `getFiscalConfig()` sem `empresaId` | perfil **global** `configuracoes` — usado em DistDFe / NF-e 55 / centrais (**E**, fora de 05.46) |
| `nfeEmissorVenda.js` | `getFiscalConfig()` sem empresa — **E** |

---

## T09 CANCELAMENTO — **A** (ownership primeiro) · residual de ordem

**PUT `cancelarVendaPut` (ordem real):**

1. `SELECT * FROM vendas WHERE id = ?` (global por id) — **B**
2. `exigirOperacaoReversaoDaVenda` — ownership + cruzado **antes** de mutações
3. `gravarAuditoria`
4. Se NFC-e autorizada: **cancelar na SEFAZ** e só então cancelamento local
5. `BEGIN IMMEDIATE` → itens → estoque/lotes → recebimentos → UPDATE venda → `cancelarFinanceiroVenda` → INSERT estorno → COMMIT

Risco residual (pré-existente): SEFAZ pode suceder e estoque/financeiro falhar. Não é troca de empresa.

**POST `cancelarVendaPost`:** ownership primeiro; cancela financeiro; **não** insere estorno PUT.

---

## T10 DEVOLUÇÃO — **A**

1. `SELECT * FROM vendas WHERE id = ?` — **B**
2. `exigirOperacaoReversaoDaVenda` antes de alterar
3. Lotes: `devolverLotesParcialItem(..., { empresaId da venda })`
4. Financeiro: `resolverEmpresaDaOrigemFinanceira({ venda })`
5. Venda NULL → falha antes da mutação

`vendas_devolucoes` não tem `empresa_id` (indireto via `venda_id`).
