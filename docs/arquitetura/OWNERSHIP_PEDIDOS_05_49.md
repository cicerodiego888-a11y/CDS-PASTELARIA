# OWNERSHIP EMPRESARIAL DO PEDIDO — Sprint 05.49

**Status:** implementado  
**Data:** 2026-08-25  
**Dependência:** reservas com `empresa_id` (05.47); auditoria 05.48 (buraco D)

## Fonte de verdade

A partir desta sprint:

```
EMPRESA
   ↓
PEDIDO.empresa_id
   ↓
RESERVA.empresa_id
   ↓
ESTOQUE_EMPRESA
```

`pedidos.empresa_id` é o **ownership definitivo** do pedido comercial.

O contexto HTTP, o usuário autenticado, COMPAT e a empresa operacional **autorizam**. Não substituem o dono persistido.

Não é fonte de verdade após o pedido existir:

- `req.empresaId` / header / body / query
- empresa do usuário
- `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA`
- última empresa utilizada
- empresa 1 / CNPJ global

## Invariante

Pedido **novo** falha se não houver empresa do contexto:

```
EMPRESA_CONTEXT_REQUIRED
```

Pedido **existente** sem `empresa_id` (legado) falha em operação mutável:

```
EMPRESA_OWNERSHIP_REQUIRED
```

Acesso cruzado (empresa B opera pedido A) não revela existência:

```
404 PEDIDO_NAO_ENCONTRADO
```

Divergência caller × `pedidos.empresa_id` no Motor:

```
PEDIDO_EMPRESA_DIVERGENTE
```

A coluna permanece **nullable** no SQLite para preservar legado não classificado.

```
pedido novo  → empresa_id obrigatório (aplicação)
pedido legado sem vínculo auditável → empresa_id NULL
```

## Migration

Arquivo: `backend/utils/pedidosEmpresaHelpers.js`  
Gatilho: `database.js` → `inicializarBanco` (após 05.41).

1. `ALTER TABLE pedidos ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)` (idempotente)
2. `CREATE INDEX IF NOT EXISTS idx_pedidos_empresa_id ON pedidos(empresa_id)`
3. Backfill **somente** quando 1:1 auditável:

| Prioridade | Origem | Condição |
|------------|--------|----------|
| 1 | `pedido_estoque_reservas.empresa_id` | exatamente uma empresa distinta nas reservas do pedido |
| 2 | `vendas.empresa_id` | via `pedidos.venda_id` 1:1 |
| — | — | conflito reserva×venda ou >1 empresa nas reservas → NULL |

Não preenche NULL com empresa operacional, contexto, COMPAT ou “única empresa ativa”.

Log:

```
MIGRATION_PEDIDOS_EMPRESA_05_49 | TOTAL | CLASSIFICADOS | VIA_RESERVA | VIA_VENDA | AMBIGUOS | SEM_CLASSIFICACAO
```

Acervo vivo (`mercadao.db`, 2026-08-25): **0 pedidos** → todos os contadores 0.

## Criação e leitura

- Criação: `exigirEmpresaDaCriacao` / `resolverEmpresaIdParaPedido` — contexto obrigatório.
- Listagem (`listarPedidos`, `listarAguardandoFaturamento`): exige `filtros.empresaId`; sem empresa retorna vazio (`1=0`), não todas as empresas. NULL excluído.
- Detalhe / mutação: `exigirPedidoDaEmpresa` (404 cruzado) ou `exigirOperacaoDoPedido` (NULL → `EMPRESA_OWNERSHIP_REQUIRED`; cruzado → 404).

## Catálogo de produtos

`produtos` permanece compartilhado. A separação operacional é **EMPRESA + PRODUTO** em `estoque_empresa`, não SKU por empresa.
