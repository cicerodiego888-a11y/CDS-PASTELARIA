# Relatório — Implementação 03.4
## Contexto empresarial obrigatório — operações novas

**Data:** 2026-08-15 · **Status:** concluída (critérios da Sprint)

---

## 1. Resumo

Operações **novas** da Fase Empresas passaram a exigir `empresaId` real: o backend resolve o contexto, valida empresa e vínculo, e **usa** `req.empresaId` na mutação. O CDS **não** ficou inteiro multiempresa. COMPAT dos fluxos 02.x permanece. Estoque, JWT, login e motores não foram alterados.

---

## 2. Operações escolhidas

- `PUT /api/empresas/:id` — alteração da empresa selecionada (`:id` deve ser o contexto).
- Admin de vínculo `GET/POST/PATCH/DELETE /api/auth/usuarios/:id/empresas` — só opera sobre a empresa do contexto.

Fora (documentado): criar empresa (bootstrap), listagens 03.1, seletor 03.2, ativar/inativar (inativa não pode ser contexto).

---

## 3. Arquivos criados

- `tests/empresas/contexto-obrigatorio-03-4.test.js`
- `docs/arquitetura/IMPLEMENTACAO_03_4_CONTEXTO_OBRIGATORIO.md`
- `docs/arquitetura/IMPLEMENTACAO_03_4_RELATORIO.md` (este)

## 4. Arquivos alterados

- `backend/services/fiscalNaoFiscal/empresaContexto.js` — `criarMiddlewareContextoEmpresa(db, { obrigatorio: true })` + `exigirEmpresaAlvoDoContexto`
- `backend/services/fiscalNaoFiscal/index.js` — reexporta o helper
- `backend/rotas/empresas.js` — PUT com contexto obrigatório
- `backend/rotas/auth.js` — vínculos com contexto obrigatório

Não alterados: JWT, login, `usuarios`, produtos, saldos, reservas, MTS, MUC, MIIP, Central, TEF, motores, `COMPAT_*`.

---

## 5. Testes 03.4

`node tests/empresas/contexto-obrigatorio-03-4.test.js` → **10/10 OK**

Inclui o cenário A autorizado → B autorizado (troca) → C sem vínculo (403).

---

## 6. Regressão

| Suíte | Resultado |
|---|---|
| 03.1 cadastro | 17/17 |
| 03.2 contexto | 11/11 |
| 03.3 vínculo | 16/16 |
| 03.4 obrigatório | 10/10 |
| 02.1 ajuste | 15/15 |
| 02.2 recálculo | 15/15 |
| 02.3 crédito compra | 11/11 |
| 02.4 débito compra | 12/12 |
| 02.5 crédito venda | 12/12 |
| 02.6 débito venda | 12/12 |
| 02.7 reservas PDV | 11/11 |
| Porta pública | 17/17 |
| MTS | homologado |
| MUC contrato | 20/20 |
| Motor Comercial RC3.16.1 | homologado |

---

## 7. Critérios

| Critério | Status |
|---|---|
| Contexto chega ao backend / `req.empresaId` oficial | sim |
| Operações escolhidas exigem empresaId | sim |
| Inexistente / inativa / não autorizada rejeitadas | sim |
| Autorizada funciona; troca altera contexto | sim |
| `X-Empresa-Id` não bypassa | sim |
| Sem fallback silencioso | sim |
| COMPAT legado | sim |
| Módulos operacionais / estoque / JWT | não migrados |
| `estoque_empresa` / produto global | intactos |
| Testes 03.1–03.3 e 02.1–02.7 | passam |

---

## 8. Próxima sprint

03.5 — migração dos escritores restantes, antes de `estoque_empresa`.
