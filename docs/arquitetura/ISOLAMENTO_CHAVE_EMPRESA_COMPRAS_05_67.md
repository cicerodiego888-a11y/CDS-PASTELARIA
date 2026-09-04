# Isolamento da chave de acesso na criação de compras (Sprint 05.67)

**Status:** implementação  
**Data:** 2026-08-29

## Chamadores (auditoria)

| Função / SQL | Arquivo | POST `/api/compras`? | Central? |
|--------------|---------|----------------------|----------|
| `SELECT id, status FROM compras WHERE chave_acesso = ? LIMIT 1` | `backend/rotas/compras.js` (antes desta sprint) | **Sim** | Não |
| `existeCompraComChave` → `WHERE chave_acesso = ? LIMIT 1` | `CentralDfePersistenciaService.js` | Não | **Sim — NÃO ALTERADO** |

Não há função compartilhada. O POST não chamava `existeCompraComChave`.

## Consulta anterior (POST)

```
WHERE chave_acesso = ? LIMIT 1
```

antes de `resolverEmpresaDaCompra`. Risco D: B via `id` de A e era bloqueado.

## Consulta nova

Depois de `resolverEmpresaDaCompra` (mesma fonte 05.56/05.57: documento Central, HTTP/body, EMPRESA_SIMPLES operacional):

```
WHERE chave_acesso = ? AND empresa_id = ?
```

parâmetros: `[chaveLimpa, empresaIdOperacao]` com `empresaIdOperacao = resolvida.empresaId`.

Não usa `req.empresaId` como dono. Sem COALESCE. Sem COMPAT.

## Comportamento

| Caso | Resultado |
|------|-----------|
| A + X, criar A + X | duplicidade, mensagem com `#id` da própria empresa |
| A + X, criar B + X | não encontra A; INSERT permitido |
| X + `empresa_id` NULL | não é dono de A |
| EMPRESA_SIMPLES | empresa operacional já resolvida no contrato |
| MULTIEMPRESA | A+X e B+X independentes |

## Central

Fora do escopo. `existeCompraComChave` permanece global.

## Riscos restantes

Duplicidade de chave na Central; classificador CNPJ; UPDATE devolução só por id.
