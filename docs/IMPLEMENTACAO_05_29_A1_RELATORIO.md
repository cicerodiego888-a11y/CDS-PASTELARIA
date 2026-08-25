# AUDITORIA 05.29.A.1 — REAPROVEITAMENTO PDV OPERACIONAL

**Tipo:** Auditoria profunda (sem implementação)  
**Data:** 2026-08-23  
**Escopo:** PDV legado, PDV Universal, rotas/services diretamente alcançados

---

## 1. Arquivos realmente analisados

### Frontend legado (partida + imports diretos)
- `frontend/pdv/index.html`
- `frontend/pdv/js/pdv.js`
- `frontend/pdv/js/caixa.js`
- `frontend/pdv/js/entregas.js`
- `frontend/pdv/js/pdv-prestacao-entrega.js`
- `frontend/pdv/js/pdv-venda-entrega.js`
- `frontend/shared/js/tefFluxoPagamento.js`
- Referências diretas: `fiscalImpressao.js`, `motor-preco-atacado.js`, `pdvBuscaProduto.js`

### Frontend Universal
- `frontend/pdv-universal/index.html`
- `frontend/pdv-universal/pdv-universal.js`
- `frontend/pdv-universal/pdv-universal-cart.js`
- `frontend/pdv-universal/pdv-universal-checkout.js`
- `frontend/pdv-universal/pdv-universal-pagamento.js`
- `frontend/pdv-universal/pdv-universal-session.js`
- `frontend/pdv-universal/pdv-universal-identificacao.js`
- `frontend/pdv-universal/pdv-universal-pix.js`
- `frontend/pdv-universal/pdv-universal-tef.js`
- `frontend/pdv-universal/pdv-universal-pos-pagamento.js`
- `frontend/pdv-universal/pdv-universal-comprovante-modal.js`
- `frontend/shared/js/muv-comprovante-client.js`

### Backend (rotas escopo + services 1–2 níveis)
- `backend/rotas/pdv-universal.js`
- `backend/rotas/vendas.js`
- `backend/rotas/entregas.js`
- `backend/rotas/caixa.js`
- `backend/rotas/tef.js`
- `backend/rotas/pix.js`
- `backend/rotas/equipamentos.js`
- `backend/rotas/impressao.js`
- `backend/middleware/validarCaixaAberto.js`
- `backend/services/pdv-universal/*`
- `backend/services/vendas/VendaPagamentoService.js`
- `backend/services/tef/*`, `backend/services/pix/*`
- `backend/motores/muv/AtendimentoMultiempresaService.js`
- `backend/motores/muv/FiscalizarAtendimentoService.js`
- `backend/motores/muv/ComprovanteUnificadoAtendimentoService.js`
- `backend/motores/muv/impressao/*`
- `backend/motores/equipamentos/services/LayoutEtiquetaService.js`

### Referenciado fora do escopo de rotas (confirmado uso Universal)
- `backend/rotas/atendimentos.js` — `POST /api/atendimentos/:id/imprimir`

**Nenhum arquivo de código foi alterado nesta sprint.**

---

## 2. Fluxos rastreados de ponta a ponta

| Domínio | Legado | Universal | Backend convergente |
|---------|--------|-----------|---------------------|
| Carrinho / identificar | ✅ UI→identificar→cart | ✅ UI→identificar→cart | produtos.js, disponibilidade |
| Checkout venda | ✅ UI→POST /api/vendas | ✅ UI→POST checkout | **VendaPagamentoService** (EMPRESA_UNICA) |
| Atendimento MUV | ✅ via vendas MULTIEMPRESA | ✅ checkout→atendimentos/* | AtendimentoMultiempresaService |
| Caixa status | ✅ GET aberto | ✅ GET aberto | FechamentoCaixaResumoService |
| Caixa operação | ✅ abrir/fechar/sangria | ❌ só status | caixa.js rotas |
| TEF | ✅ fluxo-pdv + pagar + cancelar | ✅ pagar only | TefManager |
| PIX | ✅ config + criar + status | ✅ criar + status | pixService |
| Entrega | ✅ reserva→operação→prestação | ❌ ausente | EntregaService |
| Etiqueta balança | ✅ interpretar→cart | ❌ meta ignorada | LayoutEtiquetaService |
| Pesagem manual | parcial (modal qty) | ✅ PESAR 05.29 | local cart |
| Impressão | fiscalImpressao + impressao/tef | MUV comprovante + imprimir | ComprovantePrintService |

---

## 3. Regras reaproveitáveis encontradas

1. **Motor venda EMPRESA_UNICA único:** `VendaPagamentoService.criarVenda` — Universal já delega via adapter.
2. **Motor MUV único:** reserva → pagamento → materialização → fiscalização → comprovante.
3. **TEF único:** `POST /api/tef/pagar` → `TefManager.autorizar` — ambos PDVs usam.
4. **PIX único:** `pixService` — ambos PDVs usam criar-cobrança + status.
5. **Caixa único:** `GET /api/caixa/aberto` + middleware `validarCaixaSeOrigemPdv`.
6. **Etiqueta única:** `POST /api/equipamentos/etiquetas/interpretar` — legado usa; Universal não.
7. **Entrega completa:** `EntregaService` + rotas em `entregas.js` — legado usa; Universal não.
8. **Impressão unificada MUV:** `ComprovantePrintService` + adapters — Universal usa parcialmente (browser).
9. **Flag pesável:** `produto_fracionado` normalizado em `normalizarProdutoResposta` — Universal propaga.
10. **Identidade item:** `produto_id + empresa_id` — Universal implementado; padrão para multiempresa.

---

## 4. Duplicações encontradas

| Área | Descrição |
|------|-----------|
| Checkout entry | `POST /api/vendas` vs `POST /api/pdv-universal/checkout` (convergem no service EMPRESA_UNICA) |
| Carrinho | Array legado vs `PDVUniversalCart` |
| TEF front | `tefFluxoPagamento.js` vs lógica inline `pdv-universal-tef.js` |
| PIX front | Funções pdv.js vs `pdv-universal-pix.js` |
| Cálculo financeiro UI | MotorPrecoAtacado + handlers legado vs `calcularTotaisOperacionais` Universal |
| Impressão pós-venda | `fiscalImpressao.js` legado vs fluxo MUV Universal |

---

## 5. Serviços prontos e desconectados do Universal

| Serviço / API | Estado |
|---------------|--------|
| `POST /api/equipamentos/etiquetas/interpretar` | Backend pronto; Universal não chama |
| `GET /api/tef/fluxo-pdv` | Backend pronto; Universal exporta URL, não chama |
| `frontend/shared/js/tefFluxoPagamento.js` | Carregado no legado; **não** no Universal |
| `POST /api/tef/cancelar` | Backend pronto; Universal não usa |
| `POST /api/impressao/tef` | Backend pronto; Universal não usa |
| Rotas entrega `/api/vendas/entregas/*`, prestação | Backend pronto; Universal ausente |
| `POST /api/caixa/abrir|fechar|sangria|suprimento` | Backend pronto; Universal só consulta aberto |
| `ThermalPrintAdapter` | Backend pronto; Universal só BROWSER |
| `meta.peso` do identificar | Retornado; Universal força qty=1 |
| `motor-preco-atacado.js` | Legado usa; Universal não importa |

---

## 6. O que NÃO existe (comprovado)

- Entrega no frontend Universal
- Pagamento misto balcão no Universal
- Pagamento a prazo no Universal
- TEF/PIX multiempresa no Universal (gates explícitos no código)
- UI fechamento caixa no Universal
- Integração balança física contínua no Universal
- Terceiro motor de venda além de VAS/MUV

---

## 7. Funcionalidades do Universal que NÃO devem ser recriadas

| Funcionalidade | Usar existente |
|----------------|----------------|
| Finalizar venda EMPRESA_UNICA | `POST /api/pdv-universal/checkout` → `VendaPagamentoService` |
| Finalizar MULTIEMPRESA | `AtendimentoMultiempresaService` |
| TEF débito/crédito | `POST /api/tef/pagar` |
| PIX | `POST /api/pix/criar-cobranca` + status |
| Comprovante | `ComprovanteUnificadoAtendimentoService` |
| Impressão | `POST /api/atendimentos/:id/imprimir` |
| Caixa (bloqueio) | `validarCaixaSeOrigemPdv` |
| Produto pesável | flags `produto_fracionado` do backend |
| Etiqueta (futuro) | `LayoutEtiquetaService` — não reimplementar parser |
| Entrega (futuro) | `EntregaService` — não criar motor entrega novo |

---

## 8. Ordem recomendada de integração

Ver detalhes em `docs/arquitetura/PLANO_REAPROVEITAMENTO_A1.md`.

Resumo:
1. TEF fluxo compartilhado (`tefFluxoPagamento.js` + fluxo-pdv)
2. Etiqueta/peso → carrinho
3. Cancel TEF
4. Entrega (UI Universal → APIs existentes)
5. Caixa operacional UI
6. Atacado/desconto automático
7. PIX-TEF, misto, prazo
8. TEF/PIX multiempresa
9. Balança física

---

## Documentos entregues

1. `docs/arquitetura/AUDITORIA_A1_REAPROVEITAMENTO_PDV_OPERACIONAL.md` — matriz 60 recursos
2. `docs/arquitetura/MAPA_FLUXOS_A1_PDV_OPERACIONAL.md` — fluxos Legado × Universal
3. `docs/arquitetura/PLANO_REAPROVEITAMENTO_A1.md` — P0/P1/P2/P3
4. `docs/IMPLEMENTACAO_05_29_A1_RELATORIO.md` — este relatório

---

## Resumo executivo quantitativo

| Métrica | Valor |
|---------|-------|
| **Total recursos analisados** | 60 |
| **Reutilizáveis diretamente (R1 / P0)** | 22 |
| **Precisam adaptação (R2/R3/R4 / P1)** | 30 |
| **Duplicados (R5 / P2)** | 6 |
| **Desconectados (prontos, Universal não usa)** | 10 serviços/APIs listados §5 |
| **Realmente ausentes (R7 / P3)** | 7 |
| **Obsoletos confirmados** | 0 no escopo |

---

## Declaração

Esta sprint **não implementou** alterações de código.  
Aguardar decisão do Product Owner para próximas sprints de integração.
