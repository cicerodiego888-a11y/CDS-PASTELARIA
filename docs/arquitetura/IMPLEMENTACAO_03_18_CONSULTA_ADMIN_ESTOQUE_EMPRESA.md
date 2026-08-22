# Implementação 03.18 — consulta administrativa de estoque por empresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Rota

`GET /api/estoque/empresa/produtos/:produtoId`

Arquivo: `backend/rotas/estoque.js`  
Montagem: `server.js` → `/api/estoque` + `verificarToken`

---

## empresaId

Exclusivamente `req.empresaId` após:

`criarMiddlewareContextoEmpresa(db, { obrigatorio: true })`

Valida empresa existente, ativa e vínculo do usuário. Sem contexto → `EMPRESA_OBRIGATORIA`. Sem fallback / COMPAT / empresa 1 / CNPJ.

---

## Leitura

`EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId: req.empresaId, db })`

Registro: **200** com SF, SNF, EA, RF, RNF.  
Ausência: **404** `ESTOQUE_EMPRESA_NAO_ENCONTRADO`.

Não consulta `produtos`. Não cria registro. Não executa backfill.

---

## O que NÃO mudou

Porta pública em `produtos`. Dual-write, backfill, CREATE, PDV, vendas, compras, reservas e motores intactos.
