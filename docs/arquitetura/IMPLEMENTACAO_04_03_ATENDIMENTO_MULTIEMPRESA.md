# Implementação 04.03 — Atendimento multiempresa + operações empresariais

**Data:** 2026-08-21 · **Motor:** Universal de Vendas (MUV)

## Tabelas

Criadas em `backend/motores/muv/atendimentoSchema.js`, bootstrap em `database.js`.

| Tabela | Papel |
|---|---|
| `atendimentos` | Checkout do cliente. `codigo` operacional (`ATD-00000001`). Não é `vendas.id`. |
| `atendimento_operacoes` | Uma linha por empresa do atendimento. `UNIQUE(atendimento_id, empresa_id)`. |
| `atendimento_operacao_itens` | Itens da operação. `empresa_id` obrigatoriamente igual ao da operação. |

`vendas` / `vendas_itens` **não** foram alteradas.

## Contratos

Em `backend/motores/muv/contratos.js`:

- `STATUS_ATENDIMENTO`: ABERTO → VALIDADO (máximo desta Sprint). Também: AGUARDANDO_PAGAMENTO, CONCLUIDO, CANCELADO (não usados).
- `STATUS_OPERACAO_EMPRESARIAL`: ABERTA → VALIDADA.
- `validarItensEntradaAtendimento` / `agruparItensPorEmpresa`
- `empresaId` oficial. `empresa_id`, CNPJ e nome **não** substituem.

## Fluxo

```
VendaApplicationService
        │
        ▼
resolverModoOperacaoVendaAtivo()
        │
        ├── EMPRESA_UNICA → fluxo legado (VendaPagamentoService)
        └── MULTIEMPRESA
                │
                ▼
        AtendimentoMultiempresaService.criarAtendimento
                │
                ├── validar itens
                ├── agrupar por empresa
                ├── exigir empresa cadastrada
                ├── consultarDisponibilidade({ empresaId })
                ├── BEGIN IMMEDIATE
                │     criar atendimento + operações + itens
                │     atualizar totais / status VALIDADO
                └── COMMIT → preview (venda_concluida: false)
```

## Atomicidade

Uma transação `BEGIN IMMEDIATE`. Qualquer erro → `ROLLBACK`. Sem atendimento órfão, sem operação parcial. `AtomicidadeMuv.ROLLBACK_TOTAL`.

## Agrupamento

Mesmo `produtoId + empresaId` soma quantidade se `valorUnitario` e `tipoFiscal` forem iguais. Caso contrário: `ITEM_ATENDIMENTO_INCONSISTENTE`.

Totais: `arredondarCentavosMuv` (2 casas). `soma(subtotais) == valor_total`.

## Isolamento / estoque

Reutiliza `reservasPublico.consultarDisponibilidade` com `opts.empresaId`.

| Contexto | Origem | Sem registro |
|---|---|---|
| Com `empresaId` | `estoque_empresa` | zero |
| Sem `empresaId` | não ocorre neste executor | — |

`produtos` (legado) **não** autoriza. Sem backfill. Sem criar `estoque_empresa`.

`SALDO_INSUFICIENTE` traz `produto`, `empresa`, `solicitado`, `disponivel`. Nenhuma operação é confirmada parcialmente.

## COMPAT

`EMPRESA_UNICA` não cria atendimento e não passa por este serviço.

## Ainda não implementado

Pagamento, TEF/PIX, divisão, baixa definitiva, criação de `vendas`, NFC-e, financeiro, caixa, UI.

## Riscos

- Sem reserva de estoque nesta Sprint: dois atendimentos VALIDADO podem competir pelo mesmo saldo até a 04.04.
- `codigo` provisório é reescrito para `ATD-{id}` na mesma TX.

## Próximo ponto

**04.04** — reserva por operação / preparação de pagamento. Não iniciada.
