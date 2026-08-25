# Compras por Empresa — V1

**Sprint:** 05.38.F.B  
**Estado:** B (código + testes; sem validação manual completa)

---

## 1. Ownership estrutural

```
compras.empresa_id  →  fonte da verdade da compra
        ├── estoque (mesma empresa)
        ├── financeiro (mesma empresa)
        └── Central (validação documento.empresa_id === compra.empresa_id)
```

Filhos (`compras_itens`, `compras_devolucoes`) **não** possuem `empresa_id`; herdam da compra.

---

## 2. Prioridade de resolução (`resolverEmpresaDaCompra`)

1. Documento Central (`central_documento_id` → `empresa_id`)
2. Contexto HTTP (`req.empresaId` / `X-Empresa-Id`)
3. Body explícito (só se compatível com 1 e 2)
4. Contrato `EMPRESA_SIMPLES`

Divergências → `EMPRESA_COMPRA_INCOMPATIVEL`  
MULTI sem empresa → `EMPRESA_COMPRA_AUSENTE`

Uma única `empresaCompraId` antes do `BEGIN`; reutilizada no INSERT, estoque, financeiro e vínculo Central.

---

## 3. EMPRESA_SIMPLES

Sem header: resolve empresa operacional via contrato.  
Transparente; estoque/financeiro com a mesma empresa.

---

## 4. MULTIEMPRESA

Empresa obrigatória.  
Estoque com `exigirEmpresa: true` (sem COMPAT silencioso em compra nova).  
Listagens e mutações filtradas/guardadas por `compras.empresa_id`.

---

## 5. Central → Compra

Documento A + contexto B → bloqueio.  
`vincularCompra` exige `empresaId` real da compra (sem `|| documento.empresaId`).

---

## 6. Compra → Estoque / Financeiro

Portas existentes + `criarFinanceiroCompra` com `empresa_id: empresaCompraId`.

Cancel/devolver: autoridade = `compra.empresa_id` (não o header isolado).

---

## 7. Ownership / listagens

`GET /`, `GET /:id`, cancelar, devolver, relatório uso/consumo → `resolverEmpresaContextoCompra` + `exigirCompraDaEmpresa`.

---

## 8. Legado NULL

Backfill: Central → financeiro inequívoco → SIMPLES operacional.  
MULTI ambíguo permanece `NULL`.  
Operar legado NULL em MULTI → `EMPRESA_COMPRA_NAO_RESOLVIDA`.
