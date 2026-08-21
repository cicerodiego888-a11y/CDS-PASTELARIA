# Relatório — Implementação 03.1
## Cadastro oficial de empresas

**Data:** 2026-08-14 · **Status:** concluída (critérios da Sprint)

---

## 1. Resumo

Foi criado o cadastro oficial de `empresas` (CNPJ único normalizado, ativação/inativação, APIs administrativas). `empresaContexto` passou a recusar empresa inexistente e inativa quando a tabela existe. Produto continua global; estoque continua em `produtos`; COMPAT permanece; nenhum motor foi alterado.

---

## 2. Arquivos criados

- `backend/services/empresas/empresaCnpj.js`
- `backend/services/empresas/empresasSchema.js`
- `backend/services/empresas/EmpresaService.js`
- `backend/services/empresas/index.js`
- `backend/rotas/empresas.js`
- `tests/empresas/cadastro-empresas-03-1.test.js`
- `docs/arquitetura/FASE_2_EMPRESAS_03_1_CADASTRO.md`
- `docs/arquitetura/IMPLEMENTACAO_03_1_RELATORIO.md` (este)

## 3. Arquivos alterados

- `backend/database.js` — `garantirSchemaEmpresas` no bootstrap
- `backend/server.js` — `GET/POST/PUT/PATCH /api/empresas` com `verificarToken` existente
- `backend/services/fiscalNaoFiscal/empresaContexto.js` — valida existência e `ativo` na tabela oficial

Não alterados: MTS, MUC, MIIP, Central, TEF, Motor Fiscal/Não Fiscal, Motor Comercial, JWT, login, usuários, mutadores de saldo/reserva.

---

## 4. Auditoria prévia

Não havia tabela `empresas`. Havia apenas o contrato em `empresaContexto` (SELECT se a tabela existisse) e usos pontuais de `empresa_id` / CNPJ de configuração. Nenhuma duplicata.

---

## 5. Testes 03.1

`node tests/empresas/cadastro-empresas-03-1.test.js` → **17/17 OK**

Cobre criar, CNPJ válido/inválido/duplicado, buscar id/CNPJ, listar, alterar, ativar/inativar, inexistente, contexto inativa/existente, COMPAT, produto global, ausência de `estoque_empresa` e de empresa padrão.

---

## 6. Regressão 02.1–02.7

| Suíte | Resultado |
|---|---|
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

Nenhum fluxo operacional de estoque foi modificado além da validação de empresa inativa quando a tabela oficial existe **e** `empresaId` é informado. COMPAT sem `empresaId` continua aceita.

---

## 7. Critérios de sucesso

| Critério | Status |
|---|---|
| Tabela empresas criada | sim |
| CNPJ único / normalizado | sim |
| Cadastro / consulta / alteração | sim |
| Ativação / inativação | sim |
| empresaContexto reconhece empresas | sim |
| Inexistente rejeitada | sim |
| Inativa reconhecida | sim |
| COMPAT funciona | sim |
| Produto GLOBAL | sim |
| Saldo/reserva não migrados | sim |
| estoque_empresa não criada | sim |
| JWT / usuário não alterados | sim |
| Motores não alterados | sim |
| Testes novos passam | 17/17 |
| Testes 02.1–02.7 | ver regressão |

---

## 8. Próxima sprint

03.2 — contexto empresarial + seletor de empresa (login → empresas permitidas → empresa selecionada). Sem `estoque_empresa`.
