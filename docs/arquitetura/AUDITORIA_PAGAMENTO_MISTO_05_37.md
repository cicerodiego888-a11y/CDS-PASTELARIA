# AUDITORIA 05.37 — Pagamento misto (escopo cirúrgico)

**Tipo:** auditoria técnica — **sem implementação**.  
**Data:** 2026-08-23  
**Escopo:** apenas arquivos e fluxos listados na sprint.

---

## 1. Contrato real encontrado

### 1.1 Estrutura comercial (`pagamentos[]`)

Contrato usado pelo **PDV legado**, **Prestação/Entrega legado**, **adapter Universal → vendas** e **MUV**:

```javascript
pagamentos: [
  {
    forma_pagamento: string,   // ex.: 'dinheiro', 'pix', 'cartao_debito', 'cartao_credito', 'prazo'
    valor: number              // em reais, 2 casas
  }
]
```

Campos opcionais observados no fluxo fiscal (`POST /api/vendas`):

| Campo | Onde aparece |
|-------|----------------|
| `tef_transacao_id`, `nsu`, `autorizacao`, `bandeira`, `adquirente`, `tef` | PDV legado após `processarPagamentosMistosTEF`; Orquestrador backend |
| `tipo_recebimento` | `'fiscal'` \| `'nao_fiscal'` — distribuição MIDP / venda mista fiscal+operacional |

### 1.2 Campo agregado da venda

```javascript
forma_pagamento: 'misto'   // quando pagamentos.length > 1
// ou forma única quando length === 1
```

Definido em:

- `frontend/pdv/js/pdv.js` → `executarFinalizacaoVenda()` (~4784)
- `backend/services/vendas/VendaPagamentoService.js` (~726–728)
- `backend/services/pdv-universal/PDVUniversalVendaAdapter.js` → `montarPayloadVendaOficial()` (~103)

### 1.3 Validação de soma (±R$ 0,01)

| Função | Arquivo | Regra |
|--------|---------|-------|
| `validarSomaPagamentosVenda` | `backend/services/vendas/VendaFinanceiroService.js` | `Math.abs(soma - total) <= 0.01` → OK; exceções para venda fiscal+operacional com `tipo_recebimento` homogêneo |
| UI legado `atualizarTotais` | `frontend/pdv/js/pdv.js` → `abrirPagamentoMisto()` | `Math.abs(falta) <= 0.01` habilita confirmar |
| UI prestação | `frontend/pdv/js/pdv-prestacao-entrega.js` | `Math.abs(soma - total) < 0.009` |
| MUV | `AtendimentoMultiempresaService.validarSomaComercial` + `ajustarPagamentosAoTotalOficial` | tolerância **1 centavo** no último pagamento |

### 1.4 Valor recebido e troco

| Recurso | Existe? | Observação |
|---------|---------|------------|
| `valor_recebido` no body de venda | Sim | `VendaPagamentoService` — campo `vendas.valor_recebido` (~700, ~1405) |
| Troco UI (dinheiro único) | Sim | `calcularTrocoPDV()`, `#valorRecebidoPDV`, modal legado `#valor-recebido` |
| Troco em pagamento misto | **Não encontrado** | Modal misto legado não captura valor recebido > parte em dinheiro; só valida soma exata das partes |

### 1.5 Formas no escopo

| Forma | Legado misto | Universal EMPRESA_UNICA | Universal MULTIEMPRESA modal |
|-------|--------------|----------------------|------------------------------|
| Dinheiro | Sim (combinações fixas) | Sim (pagamento único) | Sim (`#pdvu-pgto-forma`) |
| PIX | Sim (`dinheiro_pix`) | Sim (fluxo dedicado, total integral) | Sim (select) — **sem cobrança** |
| Débito / Crédito | Sim (`dinheiro_debito/credito`) | Sim (TEF dedicado, total integral) | Sim (select) — **sem TEF** |
| Prazo | Fora do modal misto legado | Não no checkout Universal atual | Não no modal pgto |
| Cartão + PIX | **Não** | **Não** | **Não** |

Combinações do modal legado (`abrirPagamentoMisto`): **somente** dinheiro + {pix \| débito \| crédito}.

---

## 2. Inventário por recurso

### 2.1 PDV legado — `frontend/pdv/js/pdv.js`

| Função / variável | Entrada | Saída | API / service | Reutilização |
|-------------------|---------|-------|---------------|--------------|
| `pagamentosMistos` (estado global) | UI modal | array `{ forma_pagamento, valor }` | — | **R2** — padrão de estado |
| `abrirPagamentoMisto()` | total da venda | preenche `pagamentosMistos`; `formaPagamentoSelecionadaPDV = 'misto'` | — | **R2** — referência UX; combinações fixas |
| `atualizarTotais()` (interna) | inputs `.pagamento-misto-input` | valor informado, **valor restante**, habilita botão | — | **R2** |
| `processarPagamentosMistosTEF(pagamentos)` | array pagamentos | array enriquecido com TEF por linha de cartão | TEF via `processarPagamentoTEF` | **R4** — Universal tem TEF, mas só pagamento único |
| `pagamentoMistoExigeTef(pagamentos)` | array | boolean | delega `formaPagamentoUsaTEF` | **R1** — regra em `tefFluxoPagamento.js` |
| `iniciarPixAutomaticoPDV(valorPix, { modoMisto })` | valor parcial PIX | cobrança + poll | `POST /api/pix/criar-cobranca` | **R4** — Universal PIX cobre total, não fatia mista |
| `executarFinalizacaoVenda()` | carrinho + `pagamentosMistos` | payload venda | `POST /api/vendas` | **R2** — contrato de payload |
| `calcularTrocoPDV()` | `#valorRecebidoPDV`, total | exibição troco | — | **R1** só pagamento único dinheiro |
| `TefFluxoPagamento.resolverFluxoPagamentoFiscal(...)` | flags misto | `deveUsarTefAutomatico`, etc. | `backend/services/tef/tefFluxoPagamento.js` | **R1** |

**Fluxo operacional legado (dinheiro + PIX):**

1. Operador informa valores no modal (soma = total ±0,01).
2. Se `dinheiro_pix` e PIX > 0:
   - TEF habilitado → pula PIX automático, vai direto à decisão fiscal.
   - Senão, se PIX automático ativo → `iniciarPixAutomaticoPDV(valorPix, { modoMisto: true })` **confirma só a fatia PIX**.
   - Após PIX pago (callback) → decisão fiscal → `executarFinalizacaoVenda`.
3. Se há cartão no misto → `processarPagamentosMistosTEF` autoriza **cada linha TEF separadamente** (loop sequencial, rollback em falha).

**Dinheiro no misto:** passa no array sem confirmação adicional além da soma.

---

### 2.2 Prestação entrega — `frontend/pdv/js/pdv-prestacao-entrega.js`

| Função | Entrada | Saída | API | Reutilização |
|--------|---------|-------|-----|--------------|
| `pagamentosLinhas` | UI | array `{ forma_pagamento, valor }` | — | **R2** |
| `abrirEditorMisto(total)` | prompt forma+valor | push em `pagamentosLinhas` | — | **R3** — editor mínimo (prompt) |
| `finalizarPrestacao()` | soma = total | `forma: 'misto'`, `pagamentos: pagamentosLinhas` | `POST /api/vendas` (via fluxo prestação) | **R2** — contrato idêntico |

Sem TEF/PIX por linha na prestação — registro comercial direto.

---

### 2.3 Entrega balcão legado — `frontend/pdv/js/pdv-venda-entrega.js`

| Campo | Valor |
|-------|-------|
| `forma_pagamento` | previsto (select) |
| `pagamentos` | **`[]` vazio** na criação |

Pagamento misto **ausente** no fluxo de entrega legado (só previsão).

---

### 2.4 PDV Universal — pagamento / checkout

#### `frontend/pdv-universal/pdv-universal-checkout.js`

| Função | Aceita `pagamentos[]`? | Observação |
|--------|------------------------|------------|
| `finalizarCheckout({ itens, pagamentos, ... })` | **Sim** | Repassa body intacto para `POST /api/pdv-universal/checkout` |

#### `frontend/pdv-universal/pdv-universal-pagamento.js`

| Função | Entrada | Saída | API | Reutilização |
|--------|---------|-------|-----|--------------|
| `montarPayloadPagamento({ pagamentos })` | array | `{ pagamentos, estrategia_rateio, idempotency_key }` | — | **R1** |
| `confirmarPagamento(atendimentoId, entrada)` | pagamentos[] | resposta MUV | `POST /api/pdv-universal/atendimentos/:id/pagamento` | **R1** MULTIEMPRESA |
| Comentário no arquivo | — | *"Não calcula rateio. Não chama TEF. Não materializa."* | — | limitação explícita |

#### `frontend/pdv-universal/pdv-universal.js` (comportamento atual)

| Modo | Comportamento pagamento |
|------|-------------------------|
| **EMPRESA_UNICA** | FINALIZAR envia **sempre** `pagamentos: [{ forma_pagamento, valor: total }]` (~2010). PIX/TEF têm fluxos **monolíticos** (total integral). |
| **MULTIEMPRESA** | Checkout cria atendimento; modal `#pdvu-modal-pagamento` mantém `_pagamentosIntencao[]` (add/remove). Confirma via MUV. **Sem validação front de ±0,01** (backend valida). **Sem TEF/PIX por linha.** |

---

### 2.5 Backend vendas — `backend/rotas/vendas.js` + `VendaPagamentoService.js`

| Recurso | Função / rota | Múltiplos pagamentos? | Reutilização |
|---------|---------------|----------------------|--------------|
| `POST /api/vendas` | `criarVenda` → `VendaPagamentoService` | **Sim** | **R1** |
| `formaPagamentoFinal = "misto"` | se `pagamentos.length > 1` | Sim | **R1** |
| `validarSomaPagamentosVenda` | antes do Orquestrador | Sim (±0,01) | **R1** |
| `OrquestradorPagamento.processarFluxoPagamentoVenda` | distribui fiscal/NF via MIDP; TEF por recebimento fiscal | Sim | **R1** |
| `processarTEFFiscal(recebimentosFiscal)` | loop TEF por linha | Sim | **R1** (backend) |
| `INSERT venda_pagamentos` | uma linha por pagamento | Sim | **R1** |
| `valor_recebido` | body opcional (troco dinheiro) | Pagamento único | **R3** parcial |

---

### 2.6 Backend Universal — `backend/rotas/pdv-universal.js` + services

| Rota | Repassa `pagamentos` | Destino |
|------|---------------------|---------|
| `POST /checkout` | Sim | `finalizarCheckout` |
| `POST /atendimentos/:id/pagamento` | Sim | `confirmarPagamentoPdv` → MUV |

#### `PDVUniversalVendaAdapter.js` (EMPRESA_UNICA)

| Função | Comportamento |
|--------|---------------|
| `montarPagamentosOficiais(pagamentos, total)` | Normaliza array; fallback `[{ dinheiro, total }]` |
| `montarPayloadVendaOficial` | `forma_pagamento: 'misto'` se `pags.length > 1`; chama `POST /api/vendas` indiretamente |

**Conclusão backend Universal EMPRESA_UNICA:** suporte **parcial completo no adapter** — aceita múltiplos pagamentos se o front enviar; **UI não envia**.

---

### 2.7 MUV — multiempresa (escopo pagamento)

| Recurso | Existe? | Detalhe | Classificação |
|---------|---------|---------|---------------|
| Pagamento misto (várias formas) | **Sim** | `confirmarPagamentoAtendimento` persiste `atendimento_pagamentos` | **R1** |
| Rateio por empresa | **Sim** | `calcularRateiosPorEstrategia` (POR_ITEM, PROPORCIONAL, MANUAL) | **R1** |
| TEF / PIX na confirmação MUV | **Não** | Comentário oficial: *"Não chama TEF"* | **R6** nesta etapa |
| Materialização | Agrega rateios → `venda_pagamentos` por operação | `MaterializarOperacoesAtendimento.pagamentosEmpresariais` | **R1** pós-pagamento |

Pagamento misto **existe no MUV** como **intenção comercial + rateio**, não como autorização de meios eletrônicos.

---

## 3. TEF e PIX — confirmação por parte

| Cenário | Confirmação por parte? | Onde |
|---------|------------------------|------|
| Misto dinheiro + cartão (legado) | Cartão: **TEF sequencial** por valor; Dinheiro: **nenhuma** | `processarPagamentosMistosTEF` |
| Misto dinheiro + PIX (legado, TEF off) | PIX: **cobrança automática só da fatia** (`modoMisto`); Dinheiro: **nenhuma** | `iniciarPixAutomaticoPDV` |
| Misto dinheiro + PIX (legado, TEF on) | PIX automático **pulado**; segue fluxo fiscal/TEF global | `abrirPagamentoMisto` ~4524 |
| Universal EMPRESA_UNICA | **Pagamento único** — TEF ou PIX no total | `executarCheckoutTefEmpresaUnica` / `executarCheckoutPixEmpresaUnica` |
| Universal MULTIEMPRESA | **Nenhuma** confirmação eletrônica por linha | `confirmarPagamentoUnificado` |

**Conclusão:** dividir R$ 50 PIX + R$ 50 cartão **não é operacionalmente válido** no Universal hoje sem orquestração adicional — embora o backend de vendas aceite o array após TEFs pré-autorizados no legado.

---

## 4. Checkout Universal — estado atual

| Pergunta | Resposta |
|----------|----------|
| Aceita `pagamentos[]` no body? | **Sim** (rota + adapter) |
| UI EMPRESA_UNICA usa misto? | **Não** — sempre 1 linha |
| UI MULTIEMPRESA usa misto? | **Parcial** — modal multi-linha, sem meios eletrônicos |
| Backend vendas suporta misto? | **Sim** (com Orquestrador + TEF) |
| VendaPagamentoService múltiplos? | **Sim** → `venda_pagamentos` |
| MUV múltiplos? | **Sim** + rateio |

---

## 5. Tabela consolidada

| Recurso | Já existe | Onde | Reutilização |
|---------|-----------|------|--------------|
| Contrato `pagamentos[{ forma_pagamento, valor }]` | Sim | pdv.js, VendaPagamentoService, PDVUniversalVendaAdapter, MUV | **R1** |
| `forma_pagamento: 'misto'` agregado | Sim | pdv.js, VendaPagamentoService, PDVUniversalVendaAdapter | **R1** |
| Validação soma ±R$ 0,01 | Sim | VendaFinanceiroService, MUV, UI legado | **R1** |
| Valor restante (UI) | Sim | pdv.js `abrirPagamentoMisto` | **R2** |
| Troco (`valor_recebido`) | Sim (pagamento único) | pdv.js, VendaPagamentoService | **R3** — misto sem troco |
| Modal misto legado (3 combinações) | Sim | pdv.js `abrirPagamentoMisto` | **R2** |
| TEF sequencial por linha (misto) | Sim | pdv.js + Orquestrador backend | **R4** no Universal |
| PIX fatia mista | Sim | pdv.js `modoMisto` | **R4** no Universal |
| POST /api/vendas com misto | Sim | VendaPagamentoService | **R1** |
| POST /api/pdv-universal/checkout com misto | Sim (adapter) | PDVUniversalVendaAdapter | **R1** backend / **R6** UI EMPRESA_UNICA |
| Pagamento unificado MUV | Sim | AtendimentoMultiempresaService | **R1** |
| Rateio MUV por empresa | Sim | calcularRateiosPorEstrategia | **R1** |
| UI Universal `_pagamentosIntencao` | Parcial | pdv-universal.js + index.html | **R3** |
| Prestação entrega misto | Sim | pdv-prestacao-entrega.js | **R2** referência |
| Entrega legado `pagamentos: []` | N/A | pdv-venda-entrega.js | **R6** misto |
| Cartão + PIX (sem dinheiro) | Não | — | **R6** |
| Prazo no misto Universal | Não | — | **R6** |

**Legenda:** R1 reutilização direta · R2 adaptador pequeno · R3 parcial · R4 integração · R5 duplicação (nenhum identificado) · R6 ausente

---

## 6. Duplicação (R5)

Não foi identificada duplicação problemática: o Universal **delega** EMPRESA_UNICA ao núcleo de vendas e MULTIEMPRESA ao MUV, alinhado à arquitetura existente.
