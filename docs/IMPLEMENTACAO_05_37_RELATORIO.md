# IMPLEMENTACAO 05.37 — Auditoria cirúrgica de pagamento misto

**Classificação:** **ESTADO B** (auditoria documentada + evidências no código)  
**Implementação de código:** **nenhuma** (conforme sprint)

---

## Objetivo

Mapear o que já existe para pagamento misto antes de qualquer fluxo novo no PDV Universal.

---

## Documento principal

[`docs/arquitetura/AUDITORIA_PAGAMENTO_MISTO_05_37.md`](arquitetura/AUDITORIA_PAGAMENTO_MISTO_05_37.md)

---

## Achados essenciais

### Contrato oficial

```javascript
pagamentos: [{ forma_pagamento: string, valor: number }]
forma_pagamento: 'misto'  // quando length > 1
```

Validação: **±R$ 0,01** (`validarSomaPagamentosVenda`).

### Onde já funciona ponta a ponta

| Caminho | Pagamento misto |
|---------|-----------------|
| PDV legado → `POST /api/vendas` | **Sim** (modal + TEF/PIX por fatia) |
| Prestação entrega legado | **Sim** (editor simples) |
| Universal EMPRESA_UNICA → checkout | **Backend sim** / **UI não** |
| Universal MULTIEMPRESA → MUV | **Sim** (intenção + rateio, sem TEF/PIX) |

### TEF / PIX no misto

- **Legado:** cada cartão passa TEF individual; PIX pode ser cobrado só da fatia (`modoMisto`); dinheiro não tem confirmação extra.
- **Universal:** TEF e PIX existem apenas para **pagamento único integral** — não há orquestração mista.

### Troco

Existe para **dinheiro único** (`valor_recebido` + UI troco). **Não encontrado** para pagamento misto.

---

## Arquivos auditados (escopo)

- `frontend/pdv/js/pdv.js`
- `frontend/pdv/js/pdv-prestacao-entrega.js`
- `frontend/pdv/js/pdv-venda-entrega.js`
- `frontend/pdv-universal/pdv-universal-pagamento.js`
- `frontend/pdv-universal/pdv-universal-checkout.js`
- `frontend/pdv-universal/pdv-universal.js` (modal pgto MULTIEMPRESA)
- `backend/rotas/vendas.js`
- `backend/rotas/pdv-universal.js`
- `backend/services/vendas/VendaPagamentoService.js`
- `backend/services/vendas/VendaFinanceiroService.js`
- `backend/services/OrquestradorPagamento.js`
- `backend/services/pdv-universal/PDVUniversalVendaAdapter.js`
- `backend/motores/pdv-universal/PDVUniversalApplicationService.js`
- `backend/motores/muv/AtendimentoMultiempresaService.js`
- `backend/services/tef/tefFluxoPagamento.js`

---

## Não alterado

Frontend, backend, rotas, services, checkout, MUV, VAS, TEF, PIX, PDV legado.

---

## Decisão final (resumo executivo)

### A. Reutilizar imediatamente (R1)

- Contrato `pagamentos[]` + `forma_pagamento: 'misto'`
- `validarSomaPagamentosVenda` (±0,01)
- `PDVUniversalVendaAdapter.montarPagamentosOficiais`
- `POST /api/pdv-universal/checkout` pass-through de `pagamentos`
- `VendaPagamentoService` + `OrquestradorPagamento` + `venda_pagamentos`
- MUV `confirmarPagamentoAtendimento` + rateio `POR_ITEM`
- `tefFluxoPagamento.pagamentoMistoExigeTef`

### B. Adaptador pequeno (R2)

- UI valor informado / valor restante (espelhar `abrirPagamentoMisto`)
- Montagem de payload a partir de estado local (padrão `pagamentosMistos` / `_pagamentosIntencao`)
- Referência UX da prestação (`pagamentosLinhas`)

### C. Parcial (R3)

- Modal Universal MULTIEMPRESA (`_pagamentosIntencao`) — multi-linha sem meios eletrônicos nem bloqueio front de soma
- Troco / `valor_recebido` — só pagamento único
- Backend Universal aceita misto; front EMPRESA_UNICA não envia

### D. Realmente ausente (R6)

- Pagamento misto **operacional** no Universal EMPRESA_UNICA (TEF/PIX por fatia)
- Combinação **cartão + PIX** (sem dinheiro) no legado
- Troco explícito no misto
- TEF/PIX na confirmação MUV
- Entrega Universal com `pagamentos[]` (continua previsto vazio)

### E. Proposta Sprint 05.38 (baseada apenas no encontrado)

**Escopo mínimo recomendado — EMPRESA_UNICA primeiro:**

1. **Adaptador** `pdv-universal-pagamento-misto.js` — espelhar contrato legado (`pagamentos[]`, soma ±0,01, valor restante); **sem** duplicar Orquestrador/MIDP.
2. **UI modal** — reutilizar combinações já existentes no legado (dinheiro+{pix,débito,crédito}); bloquear confirmar se `|restante| > 0.01`.
3. **Orquestração pré-checkout** — antes de `Checkout.finalizarCheckout`:
   - fatia cartão → reutilizar `pdv-universal-tef.js` **por valor parcial** (padrão `processarPagamentosMistosTEF`);
   - fatia PIX → reutilizar `pdv-universal-pix.js` com valor parcial (padrão `modoMisto` legado);
   - dinheiro → incluir no array sem gateway.
4. Enviar `pagamentos` enriquecidos (com `tef_transacao_id` quando aplicável) via checkout existente → `PDVUniversalVendaAdapter` → `POST /api/vendas`.

**MULTIEMPRESA (fase 2, se necessário):**

5. Completar modal existente: validação front ±0,01, desabilitar confirmar se diferença ≠ 0.
6. **Não** prometer TEF/PIX por linha no MUV até existir etapa de materialização/fiscalização compatível — hoje MUV registra intenção comercial apenas.

**Fora de 05.38 (ausente no código auditado):**

- Cartão + PIX sem dinheiro
- Troco no misto
- Prazo no misto Universal

---

## Pendências reais

- Validação manual em ambiente com TEF/PIX habilitados (ESTADO A)
- Definir se EMPRESA_UNICA misto exige mesma regra legado “TEF on pula PIX automático”
- Política de troco quando parte em dinheiro > valor da fatia
