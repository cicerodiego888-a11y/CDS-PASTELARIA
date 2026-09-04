# OWNERSHIP DE CANCELAMENTO E DEVOLUÇÃO — Sprint 05.42

**Status:** implementado  
**Data:** 2026-08-25  
**Dependência:** Sprint 05.40 (`vendas.empresa_id`) e Sprint 05.41 (`financeiro.empresa_id`)

## Fonte autoritativa

```
EMPRESA
   ↓
VENDA (vendas.empresa_id)
   ↓
CANCELAMENTO / DEVOLUÇÃO
   ├── ESTOQUE DA MESMA EMPRESA
   └── FINANCEIRO DA MESMA EMPRESA
```

A empresa da operação de reversão **é sempre** a empresa da venda original.

Não se determina empresa por:

- `req.empresaId` (contexto atual)
- empresa selecionada no frontend
- caixa ativo / último caixa
- empresa global / COMPAT
- MUV
- fallback automático

Helper reutilizado (05.40), sem duplicar regra de listagem:

- `resolverEmpresaDaVenda(venda)` — lê só `vendas.empresa_id`
- `exigirOperacaoReversaoDaVenda(venda, contexto)` — ownership da venda + autorização do contexto
- `resolverEmpresaDaOrigemFinanceira({ venda })` (05.41) — estorno financeiro

O contexto HTTP (`req.empresaId`) **autoriza** a operação (isolamento cruzado). **Não** define a empresa do estoque nem do financeiro.

## Regra de cancelamento

1. Localizar venda por `id`
2. `resolverEmpresaDaVenda` — se `empresa_id` NULL → `EMPRESA_OWNERSHIP_REQUIRED` (sem efeito colateral)
3. Contexto atual deve ser a mesma empresa → senão `VENDA_NAO_ENCONTRADA` (404)
4. Só então: NFC-e/TEF já existentes, retorno de estoque, financeiro, status

Estoque: `montarOpcoesRetornoEstoqueDaVenda(venda, …)` com `exigirEmpresa: true`.

Financeiro do estorno PUT: `financeiro.empresa_id = venda.empresa_id`.

## Regra de devolução

Idêntica. A devolução **não escolhe** empresa.

Estoque: mesmo helper, origem `devolucao_venda`.

Financeiro: `recalcularFinanceiroDevolucaoVenda` resolve empresa **antes** de qualquer UPDATE/INSERT, via `resolverEmpresaDaOrigemFinanceira({ venda })`. Não usa `opcoes.empresaId || null`.

## Vendas legadas (`empresa_id = NULL`)

Não se infere ownership. Cancelamento e devolução que gerariam movimento empresarial são **bloqueados**:

```
EMPRESA_OWNERSHIP_REQUIRED
```

A venda não é atualizada automaticamente. Estoque e financeiro não são alterados.

## Acesso cruzado

Venda da empresa A + contexto B:

```
VENDA_NAO_ENCONTRADA
HTTP 404
```

Não revela existência, itens, valores nem saldos.

## Fluxo venda → estoque

```
venda.empresa_id
        ↓
montarOpcoesRetornoEstoqueDaVenda
        ↓
creditarEstoqueItemVenda(empresaId da venda)
        ↓
estoque_empresa da EMPRESA DA VENDA
```

Produto X na empresa A e na empresa B: cancelar/devolver venda da A credita **somente** A.

## Fluxo venda → financeiro

```
venda.empresa_id
        ↓
resolverEmpresaDaOrigemFinanceira({ venda })
        ↓
financeiro.empresa_id
```

INSERT novo de cancelamento (PUT) e de estorno de devolução exigem `empresa_id` da venda. Não há NULL em operação empresarial nova.
