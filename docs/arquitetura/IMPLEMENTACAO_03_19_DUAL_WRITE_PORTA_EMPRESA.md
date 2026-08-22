# Implementação 03.19 — contexto operacional e dual-write centralizado

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Rotas com contexto opcional

`criarMiddlewareContextoEmpresa(db)` (sem `obrigatorio: true`) em:

- `backend/rotas/produtos.js`
- `backend/rotas/compras.js`
- `backend/rotas/vendas.js`

Sem header: `req.empresaId = null`, fluxo legado.  
Com `X-Empresa-Id`: valida existência, ativo e vínculo.

---

## Origem e propagação de empresaId

1. Middleware anexa `req.empresaId` validado.
2. `empresaIdDoReqOperacional(req)` — contexto validado prevalece; body/user só se não houver contexto.
3. Ajuste, compra e venda passam esse id às opts da porta.

---

## Dual-write na porta

`estoqueSaldosPublico._ajustarSaldo` (crédito/débito):

1. altera `produtos`
2. se `empresaId` válido → `EstoqueEmpresaService.aplicarEfeitoSaldo` (mesmo db, mesmo delta)

Sem empresaId: COMPAT, só `produtos`.  
Registro inexistente: nasce zerado + delta atual. Sem copiar `produtos`. Sem backfill.  
Sem tabela `empresas`: não espelha (harness pré-cadastro).

---

## Leitura

`consultarSaldo` da porta continua em `produtos`. Sem dual-read.

---

## Isolamento

Empresa A +10 e B +20 no mesmo produto: EE A=10, EE B=20. Débito em A não altera B.

Rollback externo restaura `produtos` e `estoque_empresa`.
