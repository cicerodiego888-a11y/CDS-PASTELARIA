# Implementação 03.12 — acesso isolado a estoque_empresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Papel desta Sprint

A 03.11 criou a tabela. Esta Sprint cria **somente** a camada de acesso.

`estoque_empresa` **ainda não** é o storage operacional oficial.

---

## Storage

Antes e depois da 03.12:

```
porta pública (estoqueSaldosPublico)
      ↓
produtos
```

Camada nova, isolada, **não conectada** à porta:

```
EstoqueEmpresaService
      ↓
estoque_empresa
```

Nenhum fluxo de compras, vendas, PDV, reservas, CREATE, motores ou porta pública foi migrado.

---

## Serviço

`backend/services/estoque/EstoqueEmpresaService.js`

| Função | Comportamento |
|---|---|
| `consultarSaldo({ produtoId, empresaId }, { db })` | lê a linha; retorna `null` se não existir |
| `existeRegistro(...)` | boolean |
| `criarRegistro(...)` | cria explicitamente; default 0 |

Regras:

- `empresaId` obrigatório → `EMPRESA_OBRIGATORIA`
- produto inexistente → `PRODUTO_NAO_ENCONTRADO`
- empresa inexistente → `EMPRESA_NAO_ENCONTRADA`
- duplicata produto+empresa → `ESTOQUE_EMPRESA_DUPLICADO`
- `db` injetável
- consulta **não** cria registro
- **não** copia saldo de `produtos`
- **sem COMPAT** nesta camada

---

## O que NÃO existe

- backfill
- fallback silencioso para `produtos`
- auto-create na consulta
- dual-write
- redirecionamento da porta pública
- `empresaId = 1` inventado
- CNPJ como fallback

Registros são independentes por `produto_id` + `empresa_id`.

---

## Testes

`tests/estoque/estoque-empresa-service-03-12.test.js` — 01–08.
