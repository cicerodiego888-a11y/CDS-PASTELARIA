# IMPLEMENTAÇÃO 05.33 — Caixa operacional no PDV Universal

**Tipo:** implementação cirúrgica (Auditoria A1 — caixa operacional)  
**Classificação:** **ESTADO B** (código + testes automatizados; sem validação manual abrir→sangria→suprimento→fechar)

---

## 1. Endpoints existentes reutilizados

| Operação | Método | Rota |
|----------|--------|------|
| Status | `GET` | `/api/caixa/aberto` (já usado na 05.23) |
| Abrir | `POST` | `/api/caixa/abrir` — `{ valor_inicial, terminal_id?, senha_admin? }` |
| Sangria | `POST` | `/api/caixa/sangria` — `{ valor, motivo, terminal_id?, senha_admin? }` |
| Suprimento | `POST` | `/api/caixa/suprimento` — `{ valor, motivo, terminal_id?, senha_admin? }` |
| Fechar | `POST` | `/api/caixa/fechar` — `{ valor_informado, observacao, terminal_id?, senha_admin? }` |

Payloads alinhados ao PDV legado (`caixa.js`) e às rotas em `backend/rotas/caixa.js`.  
Cálculo de fechamento permanece no backend; o Universal só envia o contrato e exibe a mensagem/resumo retornado.

---

## 2. Arquivos alterados

| Arquivo | Alteração |
|---------|-----------|
| `frontend/pdv-universal/pdv-universal-caixa.js` | **Novo** — adaptador HTTP + `acoesVisiveisPorStatus` |
| `frontend/pdv-universal/pdv-universal.js` | Modal, botões por status, confirmação → refresh status |
| `frontend/pdv-universal/index.html` | Botões Abrir/Sangria/Suprimento/Fechar + modal caixa + script |
| `frontend/pdv-universal/pdv-universal.css` | Estilos mínimos dos botões/modal |
| `tests/pdv-universal/caixa-operacional-acoes-05-33.test.js` | **Novo** — 12 casos |

---

## 3. Operações adicionadas

- **FECHADO** → Abrir Caixa  
- **ABERTO** → Sangria, Suprimento, Fechar Caixa  
- **INDISPONÍVEL / VERIFICANDO** → só Atualizar status  
- Após sucesso de qualquer operação → `GET /api/caixa/aberto`  
- Carrinho e checkout **não** são tocados  

---

## 4. Testes executados

```text
node tests/pdv-universal/caixa-operacional-acoes-05-33.test.js  → 12/12
node tests/pdv-universal/caixa-operacional-05-23.test.js        → (regressão)
```

---

## 5. O que explicitamente NÃO foi alterado

- `backend/rotas/caixa.js` e services de caixa  
- `validarCaixaSeOrigemPdv`  
- Checkout Universal, MUV, VAS, TEF, PIX, motor fiscal  
- PDV legado / `caixa.js`  
- `PDVUniversalCart`  
- Novas rotas, motores ou tabelas  
