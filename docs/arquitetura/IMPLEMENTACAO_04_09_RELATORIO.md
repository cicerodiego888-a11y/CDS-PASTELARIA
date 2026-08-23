# Relatório — Sprint 04.09
## Gestão da configuração fiscal multiempresa

**Data:** 2026-08-22 · **Status:** concluída

### Por que não parou (regra 20)

A 04.08 isolou a origem da config na emissão, mas **não** havia gestão oficial (rotas, parcial, status, mascaramento). Havia lacuna de produção.

### Reutilizado

`empresasConfiguracaoFiscal.js`, `getFiscalConfig`, rotas `/api/empresas` + `verificarToken`, `certificateService` / path de PFX existente.

### Criado / alterado

- Admin no mesmo serviço fiscal (sem motor novo)
- Rotas em `backend/rotas/empresas.js`
- `tests/muv/configuracao-fiscal-multiempresa-04-09.test.js` — **26/26**
- Docs 04.09

### Testes novos

26 casos (isolamento A/B/C, parcial, PRONTA, inválida, sem fallback, GET sem segredos, body divergente, resolução, global, numeração, rollback, listar, remover, DESATIVADA, rotas, MUV limpo).

### Regressão

04.01–04.08, MUC, rc7104, orquestrador, TEF, dual-write 03.19, reservas 03.20, portas, venda-baixa, compras, cancel/devolução, MTS, expedição, pedido disponibilidade — **OK**.

Falha pré-existente (não desta sprint): `fiscal-platform` (`26 !== 24`).

### Limitações

Sem UI. Sem upload HTTP de PFX por empresa (path manual/reuso do arquivo). Sem 04.10 (comprovante/impressão).

### Próxima sprint (não iniciada)

**04.10** — comprovante unificado de atendimento (dado + impressão, se priorizado).
