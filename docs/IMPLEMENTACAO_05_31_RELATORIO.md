# IMPLEMENTAÇÃO 05.31 — Cancelamento seguro TEF no PDV Universal

**Tipo:** implementação cirúrgica  
**Classificação:** **ESTADO B** (código + testes automatizados; sem TEF físico configurado nesta sessão)

---

## 1. Arquivos alterados

| Arquivo | Alteração |
|---------|-----------|
| `frontend/pdv-universal/pdv-universal-tef.js` | `cancelarTransacaoTef`, `urlCancelar`, helpers `extrairTransacaoId`, `transacaoTefCancelavel`, `cancelamentoConfirmado` |
| `frontend/pdv-universal/pdv-universal.js` | `abortarOperacaoTef`, estado `_tefPendente` / locks, integração FECHAR/ESC e fluxo pós-`pagar` |
| `tests/pdv-universal/cancelamento-tef-05-31.test.js` | **Novo** — 8 casos |
| `tests/pdv-universal/tef-operacional-05-25.test.js` | Regressão (sem alteração de contrato) |

---

## 2. Contrato existente reutilizado

**`POST /api/tef/cancelar`** (mesmo contrato do PDV legado em `cancelarVendaAtual`):

```json
{
  "transacao_id": <number>,
  "motivo": "Cancelamento operador"
}
```

Resposta: JSON do serviço TEF (`cancelado`, `status`, `mensagem`, etc.) — sem alteração de backend.

---

## 3. Comportamento antes / depois

| Situação | Antes | Depois |
|----------|-------|--------|
| FECHAR/ESC no modal TEF com transação pendente | Fechava UI e zerava `_tefEmAndamento` sem API | Chama `POST /tef/cancelar` quando há `transacao_id` cancelável |
| TEF em andamento (await `pagar`) sem `transacao_id` | FECHAR liberava lock local | Marca `_tefCancelamentoSolicitado`; cancela ao retorno de `pagar` |
| TEF não iniciado | Sem efeito TEF | Sem chamada API (inalterado) |
| TEF aprovado + checkout iniciado | — | Não cancela (mantém fluxo) |
| Falha no cancelamento | — | Erro na UI; checkout não executado; lock de cancelamento liberado |
| Carrinho | Mantido em erros TEF | **Permanece intacto** após cancelamento |

---

## 4. Testes executados

```text
node tests/pdv-universal/cancelamento-tef-05-31.test.js   → 8/8
node tests/pdv-universal/tef-operacional-05-25.test.js    → 15/15
```

---

## 5. O que explicitamente NÃO foi alterado

- Backend TEF / `TefManager`
- `POST /api/tef/pagar`
- `POST /api/pdv-universal/checkout`
- MUV, VAS, motor fiscal
- PDV legado (`/pdv`)
- `frontend/shared/js/tefFluxoPagamento.js`
- Novas rotas ou motores TEF
