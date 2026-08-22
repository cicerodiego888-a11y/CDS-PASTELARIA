# Implementação 03.14 — backfill controlado de estoque_empresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## O que é

Rotina **manual/explícita** que copia o snapshot legado de `produtos` para `estoque_empresa` de **uma empresa**.

Não roda no bootstrap. Não é a porta pública. Não altera `produtos`.

---

## Campos copiados (schema real)

De `produtos` para `estoque_empresa` (mesmo produto, só a empresa informada):

- `saldo_fiscal`
- `saldo_nao_fiscal`
- `estoque_atual` (valor armazenado; invariante SF+SNF quando consistente)
- `reservado_fiscal`
- `reservado_nao_fiscal`

O saldo em `produtos` é global/legado. **Não** é distribuído entre empresas A+B+C.

---

## API

`backend/services/estoque/EstoqueEmpresaBackfillService.js`

- `executarBackfillEmpresa({ empresaId }, { db })`
- `executarBackfillProduto({ produtoId, empresaId }, { db })`

`empresaId` obrigatório → `EMPRESA_OBRIGATORIA`. Empresa deve existir. Sem COMPAT, sem empresa 1, sem CNPJ.

Escrita via `EstoqueEmpresaService.criarRegistro` (camada 03.12).

---

## Idempotência

- não existe → cria snapshot atual
- já existe → **não** sobrescreve (preserva dual-write 03.13)

Segunda execução não duplica nem soma.

---

## Transação

Mesmo `db` injetável. Sem BEGIN próprio. Rollback externo desfaz o backfill.

---

## O que NÃO mudou

Porta pública, dual-write 03.13, CREATE, compra, venda, PDV, reservas, motores, leitura operacional.
