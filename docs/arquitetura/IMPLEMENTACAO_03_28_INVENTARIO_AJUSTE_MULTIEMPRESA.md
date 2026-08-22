# Implementação 03.28 — inventário e ajuste administrativo multiempresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## 1. Fluxos auditados

Não existe módulo de inventário, contagem física ou “definir saldo contado” no backend.

| Fluxo | Classe | Rota | Arquivo / função | Escreve saldo | Reserva | Porta | db | empresaId antes | req.empresaId | SQL direto |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Ajuste | A | POST/PUT `/:id/ajustar-estoque` | `executarAjusteEstoque` → `aplicarAjusteEstoqueProduto` | sim (delta F/NF) | não | `estoqueSaldosPublico` | db da rota | `empresaIdDoReqOperacional` | middleware em `/api/produtos` | não (02.1) |
| Saldos iniciais PUT | A | PUT `/:id` | `aplicarSaldosIniciaisViaPorta` | sim (delta vs produtos) | não | mesma | db da rota | operacional | idem | não |
| CREATE saldo inicial | A | POST `/` | `aplicarSaldoInicialCreateProduto` | sim | não | mesma | db da rota | operacional + `req`/`contexto` | sim | não (03.8) |
| Recálculo | A | POST `/recalcular-saldos` e `/:id/recalcular-saldos` | `recalcularSaldosProduto` | sim (delta vs histórico) | não | mesma | db da rota | operacional | sim | não (02.2) |
| Importação inicial / qtd | A | POST `/api/produtos/importacao-inicial/importar` | importer / quantidadeUpdater | sim (ajuste) | não | mesma | TX do import | **não passava** | router sem middleware | não |
| Histórico / relatório / tem-mov | B | GET | `produtos.js` | não | não | — | — | — | — | n/a |
| GET estoque empresa | B | GET `/api/estoque/empresa/...` | `rotas/estoque.js` | não | não | — | — | `req.empresaId` | obrigatório | n/a |
| Bootstrap recalc | C | `database.js` | `migrarRecalcularSaldosEstoque` | sim (migração v1) | não | porta | db global | nenhum → COMPAT | n/a | não |

Equivalência crédito/débito: todos os escritores A já usavam delta F/NF pela porta. Não havia `UPDATE produtos SET estoque_atual = …` a converter.

---

## 2. Fluxos realmente alterados

```
POST/PUT /api/produtos/:id/ajustar-estoque
  → criarMiddlewareContextoEmpresa
  → empresaIdDoReqAjuste(req)   // só req.empresaId
  → aplicarAjusteEstoqueProduto
  → estoqueSaldosPublico.creditarSaldo / debitarSaldo
  → produtos + dual-write 03.19
```

O mesmo `empresaIdDoReqAjuste` vale para PUT saldos iniciais, CREATE, recálculo HTTP e importação.

`montarOptsPortaAjuste` e `montarOptsPortaRecalculo` leem somente `opcoes.empresaId`.

Importação: o router era montado fora de `produtos.js` (sem middleware). Agora tem `criarMiddlewareContextoEmpresa` e propaga `empresaId` até o ajuste.

Frontend do ajuste envia `X-Empresa-Id` (além do `ajaxSetup` do ERP).

---

## 3. Fluxos já corretos

- Porta pública e dual-write 03.19 (não recriados).
- Classificação F/NF do ajuste (deltas do body / saldos iniciais / histórico do recálculo).
- Mesmo `db` da transação do caller (sem BEGIN próprio).
- COMPAT 02.1 / 02.2 / 03.8 quando não há empresa.

---

## 4. Fluxos descartados

Inventário/contagem (não existe). Leituras. Migração bootstrap (C). MTS, MUC, compras, vendas, reservas, produção, lote (exceto o caminho de validade já existente no ajuste).

---

## 5. Limitações restantes

Recálculo bootstrap em `database.js` continua COMPAT (migração única, sem HTTP).

Saldos iniciais PUT calculam o delta contra `produtos` (leitura oficial da porta), não contra `estoque_empresa`. O dual-write aplica o **mesmo delta** na linha da empresa — comportamento 03.19, não cópia absoluta.

Candidato de outro domínio (não nesta sprint): transferência (MTS) operacional HTTP, se existir writer fora do motor.

---

## Autoridade / COMPAT / isolamento

`req.empresaId` prevalece sobre body/query/user/contexto/ctx/CNPJ. Sem empresa: só `produtos`. A +10 e B +20 isolados. Rollback externo desfaz `produtos` + `estoque_empresa`.
