# Relatório — Implementação 03.2
## Contexto empresarial + seletor de empresa

**Data:** 2026-08-14 · **Status:** concluída (critérios da Sprint)

---

## 1. Resumo

O CDS passou a ter um contexto empresarial de sessão **sem alterar JWT, login ou usuários**. Empresas ativas podem ser listadas e selecionadas; `empresaId` fica em `localStorage` e no header `X-Empresa-Id`. A resolução oficial continua em `empresaContexto.js`. Estoque permanece em `produtos`. COMPAT permanece.

---

## 2. Arquivos criados

- `frontend/shared/js/cds-empresa-contexto.js`
- `tests/empresas/contexto-empresarial-03-2.test.js`
- `docs/arquitetura/IMPLEMENTACAO_03_2_CONTEXTO_EMPRESARIAL.md`
- `docs/arquitetura/IMPLEMENTACAO_03_2_RELATORIO.md` (este)

## 3. Arquivos alterados

- `backend/services/fiscalNaoFiscal/empresaContexto.js` — `resolverEmpresaIdDaRequisicao`, middleware
- `backend/services/fiscalNaoFiscal/index.js` — reexporta helpers
- `backend/services/empresas/EmpresaService.js` — disponíveis / selecionar / obter contexto
- `backend/rotas/empresas.js` — `GET/POST /contexto*` **antes** de `/:id`
- `frontend/shared/js/core.js` — header + init + logout
- `frontend/erp/index.html` / `frontend/pdv/index.html` — host do seletor + script
- `frontend/css/style.css` — seletor compacto na sidebar

Não alterados: JWT, login, tabela `usuarios`, MTS, MUC, MIIP, Central, TEF, motores Fiscal/Não Fiscal/Comercial, mutadores de saldo.

---

## 4. Decisão: sem usuario_empresa

Não foi necessário criar `usuario_empresa`. A 03.2 usa empresas **ativas** do cadastro. Vínculo usuário ↔ empresa fica para a 03.3.

---

## 5. Testes 03.2

`node tests/empresas/contexto-empresarial-03-2.test.js` → **11/11 OK**

03.1 cadastro: **17/17 OK**

---

## 6. Regressão

| Suíte | Resultado |
|---|---|
| 03.1 cadastro | 17/17 |
| 03.2 contexto | 11/11 |
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
| Ativas consultáveis | sim |
| Inativas fora do seletor | sim |
| Seleção / troca | sim |
| empresaId no contexto | sim (`localStorage` + `X-Empresa-Id` + `req.empresaId`) |
| Inexistente / inativa rejeitadas | sim |
| Sem fallback empresa 1 / CNPJ config | sim |
| COMPAT / produto global / produtos | sim |
| estoque_empresa / JWT / motores | não alterados |

---

## 8. Próxima sprint

03.3 — vínculo usuário ↔ empresa + contexto obrigatório (ainda sem `estoque_empresa`).
