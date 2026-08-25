# OWNERSHIP FINANCEIRO — Sprint 05.41

**Status:** implementado  
**Data:** 2026-08-24  
**Dependência:** Sprint 05.40 (`vendas.empresa_id` é o ownership definitivo da venda)

## Modelo oficial

```
OPERAÇÃO EMPRESARIAL
        │
        └── empresa_id
                ↓
LANÇAMENTO FINANCEIRO
        │
        └── financeiro.empresa_id
                ↓
             EMPRESA
```

`financeiro.empresa_id` é o **ownership empresarial explícito** do lançamento.

Vínculos com venda, caixa, MUV, pedido, atendimento, recebimento ou pagamento **explicam a origem**, mas **não substituem** `financeiro.empresa_id`.

## Origem do empresa_id

Resolução central: `resolverEmpresaDaOrigemFinanceira` em `FinanceiroEmpresaContextoService.js`.

Reutiliza `exigirEmpresaDaOperacao` (05.40) via `exigirEmpresaIdFinanceiro`.

Ordem encontrada no código (fontes persistidas, sem fallback inventado):

1. origem explícita já resolvida da operação (`empresaId` / `origemExplicita`)
2. `venda.empresa_id`
3. `operacao.empresaId` (MUV)
4. `caixa.empresa_id`
5. `compra.empresa_id`

Não utiliza:

- empresa 1 / padrão / última empresa
- último caixa global
- configuração global
- `req.query.empresa_id`

Fontes conhecidas **divergentes** bloqueiam a operação:

```
FINANCEIRO_EMPRESA_DIVERGENTE
```

Não há correção silenciosa.

## Fluxo venda → financeiro

```
CONTEXTO EMPRESARIAL
        ↓
VENDA (vendas.empresa_id)          ← Sprint 05.40
        ↓
OPERAÇÃO FINANCEIRA
        ↓
financeiro.empresa_id              ← Sprint 05.41
```

Writers:

- `VendaPagamentoService` (prazo e à vista) — `empresaIdVenda` da 05.40
- `MotorFinalizacaoVenda` (prestação de entrega) — `resolverEmpresaDaOrigemFinanceira({ venda, caixa })`

Para operações novas: `financeiro.empresa_id = vendas.empresa_id`.

## Fluxo MUV → financeiro

```
operacao.empresaId
        ↓
vendas.empresa_id (materialização)
        ↓
financeiro.empresa_id
```

Writer: `MaterializarOperacoesAtendimento.persistirVendaOperacao`.

Se a operação originadora não tiver empresa: `EMPRESA_OWNERSHIP_REQUIRED` (não materializa financeiro empresarial).

## Invariante 05.41

Toda **operação financeira empresarial nova** deve possuir `empresa_id`:

```
operação nova empresarial
        =>
financeiro.empresa_id IS NOT NULL
```

Violação explícita:

```
EMPRESA_OWNERSHIP_REQUIRED
```

A coluna permanece **nullable** no SQLite para preservar legado não classificado.

## Tratamento de legado

Registros com `empresa_id = NULL`:

- classificados como `LEGADO_SEM_OWNERSHIP`
- não são atribuídos automaticamente
- não aparecem na listagem operacional (`WHERE empresa_id = ?`)
- não são apagados
- permanecem auditáveis

Não há ferramenta de saneamento manual nesta sprint.

Backfill 05.41 (após 05.40) preenche **somente** quando a origem é determinística:

| Prioridade | Fonte | Condição |
|------------|--------|----------|
| 1 | `vendas.empresa_id` | `financeiro.venda_id` ou `referencia_tipo = 'venda'` |
| 2 | `atendimento_operacoes.empresa_id` | via `venda_id` MUV |
| 3 | `caixa_sessoes.empresa_id` | via `vendas.caixa_sessao_id` |
| 4 | `compras.empresa_id` | via `financeiro.compra_id` |
| — | — | restante permanece `NULL` |

A migration 05.38.D **não é desfeita**. Registros já classificados permanecem. 05.41 só preenche NULL restante com evidência.

## Regras de leitura

Operações empresariais filtram:

```
WHERE empresa_id = ?
```

usando o contexto validado no backend (`middlewareResolverEmpresaFinanceiro`). Não se confia em `req.query.empresa_id`.

Aplica-se a listagens, detalhes, dashboards, vencimentos, relatórios e consultas operacionais auditadas nesta sprint.

## Acesso cruzado

Empresa A consultando lançamento da empresa B (ou legado NULL):

```
FINANCEIRO_NAO_ENCONTRADO
HTTP 404
```

Não retorna dados, saldo, descrição, valores nem existência do registro.

Padrão alinhado à Sprint 05.40 (`VENDA_NAO_ENCONTRADA`).

`exigirRegistroDaEmpresa` (05.38.D, 403 `FINANCEIRO_EMPRESA_DIVERGENTE`) permanece para mutações administrativas já existentes.

## Imutabilidade

Após criação operacional, `financeiro.empresa_id` **não** é alterado por UPDATE de edição. PUT não inclui `empresa_id` no SET. Não há editor administrativo nesta sprint.

## Fora de escopo (05.42+)

- cancelamento de venda (`VendaCancelamentoService`)
- devolução de venda (`VendaFinanceiroService`)
- NFC-e, caixa, reservas, lotes, DistDFe
- regras contábeis / valor fiscal vs não fiscal
