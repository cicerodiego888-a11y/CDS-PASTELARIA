# RELATÓRIO — Sprint 07 · S07-2 — Seleção segura de unidade operacional no KDS

**Data:** 2026-11-17  
**Responsável implementação:** Cursor  
**Status:** ENTREGUE PARA AUDITORIA DO TECH LEAD  
**Escopo:** listagem + seleção de unidade + reemissão JWT + UI KDS de seleção

---

## 1. Arquivos criados e alterados

### Criados
| Arquivo | Função |
|---------|--------|
| `backend/services/cozinha/CozinhaSessaoUnidadeService.js` | Listagem autorizada + seleção + emissão JWT |
| `tests/cozinha/sprint07-s07-2-sessao-unidade-kds.test.js` | Testes A–N + UI + isolamento |
| `Agent/LOG-SPRINT07-S07-2.txt` | Log dos testes |
| `Agent/RELATORIO-SPRINT07-S07-2.md` | Este relatório |

### Alterados
| Arquivo | Mudança |
|---------|---------|
| `backend/rotas/cozinha.js` | `GET /unidades-disponiveis` + `POST /sessao/unidade` |
| `frontend/erp/js/cozinha-kds.js` | Fluxo de seleção → token → painel |
| `frontend/css/cozinha-kds.css` | Estilos da tela de seleção |
| `tests/cozinha/sprint07-s07-1-painel-kds-ui.test.js` | Compatível com JWT contextualizado (S07-2) |

### Não alterados (confirmado)
- Sprint 06 (worker/fila/Electron impressão)
- Contrato S07-0 do painel (`GET /preparacao/painel`)
- `frontend/shared/js/login.js`
- PDV Universal / Express
- Schema / migrations / banco oficial
- Fiscal, financeiro, estoque

---

## 2. Diff resumido

- **Backend:** serviço reutiliza `validarUnidadeCozinhaNoLogin` + `JWT_SECRET` oficial; whitelist de claims; preserva `exp` do token atual.
- **Rotas:** dois endpoints autenticados sob `/api/cozinha`, com empresa do contexto (`X-Empresa-Id` / middleware), sem aceitar identidade/empresa no body.
- **Frontend:** se JWT já tem `unidade_cozinha_id` → painel; senão → lista unidades, exige escolha explícita, POST de sessão, substitui `localStorage.token`, só então inicia polling do painel.
- **Sem** auto-seleção da primeira unidade; **sem** `unidade_id` na query para contornar auth; **sem** reenvio de senha.

---

## 3. Endpoints e contratos

### `GET /api/cozinha/unidades-disponiveis`
**Auth:** JWT + contexto de empresa.  
**Resposta 200:**
```json
{
  "success": true,
  "empresa_id": 1,
  "unidades": [{ "id": 10, "codigo": "UA" }],
  "codigo": "SEM_UNIDADES_DISPONIVEIS",
  "mensagem": "Nenhuma unidade..."
}
```
(`codigo`/`mensagem` somente quando lista vazia.)

### `POST /api/cozinha/sessao/unidade`
**Body:** `{ "unidade_cozinha_id": 123 }`  
**Resposta 200:**
```json
{
  "success": true,
  "token": "<jwt>",
  "user": { "...", "unidade_cozinha_id": 123 },
  "unidade_cozinha_id": 123,
  "empresa_id": 1
}
```
Falhas: `UNIDADE_INEXISTENTE`, `UNIDADE_INATIVA`, `UNIDADE_EMPRESA_ISOLAMENTO`, `UNIDADE_NAO_AUTORIZADA`, `UNIDADE_OBRIGATORIA`, etc. — sem emitir token.

### Painel (inalterado)
`GET /api/cozinha/preparacao/painel` — unidade autoritativa = claim JWT.

---

## 4. Regras de autorização

| Perfil | Listagem | Seleção |
|--------|----------|---------|
| Admin operacional (`role=admin` ou perfil ADMIN/SUPER_ADMIN) | Unidades **ativas** da empresa do contexto | Mesma validação (`validarUnidadeCozinhaNoLogin`) |
| Operador | Somente com vínculo **ativo** em `cozinha_operador_unidades` | Exige vínculo ativo; revalida no POST |

- Empresa sempre do contexto autenticado (não do body).
- Unidade de outra empresa / inativa / inexistente / sem vínculo → bloqueio.
- Listagem **não** concede autorização permanente; POST revalida.

---

## 5. Estratégia de emissão e atualização do JWT

1. Reutiliza `JWT_SECRET` de `backend/middleware/auth.js` (mesmo emissor do login).
2. Claims via whitelist (`id`, `usuario_id`, `username`, `nome`, `role`, `perfil`, `permissoes`, `terminal_id`, `caixa_sessao_id`, `unidade_cozinha_id`).
3. Preserva `exp` absoluto do token atual quando ainda válido; senão `expiresIn: '8h'` (política do login).
4. Frontend: `localStorage.setItem('token', ...)` + `user` + `electronAPI.cozinhaImpressao.estabelecerSessao` quando disponível.
5. Token antigo permanece válido sem claim de unidade e **não** contextualiza o KDS (`UNIDADE_OBRIGATORIA` no painel).

**Refatoração mínima:** nenhuma segunda assinatura; emissão encapsulada em `emitirJwtComUnidade` no serviço de sessão.

---

## 6. Resultados dos testes

| ID | Cenário | Resultado |
|----|---------|-----------|
| A | Login normal sem unidade | PASS |
| B | Listagem só ativas autorizadas | PASS |
| C | Admin vê ativas da empresa | PASS |
| D | Operador só vínculo ativo | PASS |
| E | Outra empresa fora da listagem | PASS |
| F | Seleção outra empresa bloqueada | PASS |
| G | Inexistente bloqueada | PASS |
| H | Inativa bloqueada | PASS |
| I | Sem vínculo bloqueado | PASS |
| J | JWT com `unidade_cozinha_id` correto | PASS |
| K | Token anterior sem unidade | PASS |
| L | Painel com JWT contextualizado | PASS |
| M | Painel sem unidade → `UNIDADE_OBRIGATORIA` | PASS |
| N | Query `unidade_id` não substitui JWT | PASS |
| O | Regressão Sprint 05 login/unidade | PASS (7/7) |
| P | Regressão S07-0 + S07-1 | PASS (12/12 + 10/10) |

UI: seleção sem auto-escolha; confirmação atualiza sessão; falha de lista sem retry automático.

Ausência de unidades/vínculos → `SEM_UNIDADES_DISPONIVEIS` (lista vazia controlada).

---

## 7. Evidência de isolamento do banco

Flags obrigatórias nos testes:

- `CDS_BLOQUEAR_BANCO_OFICIAL=1`
- `CDS_TEST_ISOLATION=1`
- `CDS_FORCAR_LOCAL=1`
- `CDS_ALLOW_OFFICIAL_DB` ausente
- `DB_DIR` = diretório temporário `cds-cozinha-s07-2-*` / `:memory:` nos testes de serviço

Log: `Agent/LOG-SPRINT07-S07-2.txt` (inclui banner `BANCO DE TESTE EM USO` em temp).

**Não** houve migrate/abertura/reinício do banco oficial.

---

## 8. Login normal

Confirmado (teste A + regressão S05): login sem `unidade_cozinha_id` emite token e **não** exige unidade. PDV/ERP permanecem compatíveis.

---

## 9. Escopo preservado

- Sprint 06: não alterada.
- S07-0: contrato do painel intacto; apenas consumo após JWT contextualizado.
- S07-1: UI de painel preservada; estendida com modo seleção.
- Sem S07-3; sem homologação oficial.

---

## 10. Limitações / pendências

- Homologação visual oficial do fluxo de seleção **não** executada (aguarda autorização PO/TL).
- Em ambientes com schema Cozinha ainda não operacional (FK/schema), endpoints retornam `COZINHA_NAO_OPERACIONAL` (503) — comportamento já existente do módulo.
- Dependência circular de estoque no boot de testes permanece (pré-existente; fora do escopo).

---

**Conclusão:** critérios da S07-2 atendidos. Parar e aguardar auditoria do Tech Lead.  
Não iniciar S07-3. Não aplicar mudanças no banco oficial.
