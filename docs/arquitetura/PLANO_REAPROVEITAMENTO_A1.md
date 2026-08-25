# PLANO DE REAPROVEITAMENTO A1 — PDV OPERACIONAL

**Sprint:** 05.29.A.1 (auditoria)  
**Base:** matriz em `AUDITORIA_A1_REAPROVEITAMENTO_PDV_OPERACIONAL.md`  
**Princípio:** não recriar o que já existe no backend/services compartilhados

---

## P0 — JÁ EXISTE E DEVE SER USADO

Itens prontos para o PDV Universal **sem backend novo**.

| # | Recurso | Onde está | Ação Universal |
|---|---------|-----------|----------------|
| P0.1 | Checkout EMPRESA_UNICA | `POST /api/pdv-universal/checkout` → `VendaPagamentoService` | **Manter** — motor oficial |
| P0.2 | Checkout MULTIEMPRESA (MUV) | `AtendimentoMultiempresaService` + rotas atendimentos | **Manter** ciclo reserva→pagamento→materializar |
| P0.3 | Identificação produto | `POST /api/produtos/identificar` | **Manter** `pdv-universal-identificacao.js` |
| P0.4 | Busca consulta-pdv | `GET /api/produtos/consulta-pdv/buscar` | **Manter** autocomplete |
| P0.5 | Disponibilidade multiempresa | `GET /api/pdv-universal/produtos/:id/disponibilidade` | **Manter** |
| P0.6 | Carrinho `produto_id + empresa_id` | `PDVUniversalCart` | **Manter** como fonte local |
| P0.7 | Desconto/acréscimo/total | `calcularTotaisOperacionais` + adapter checkout | **Manter** |
| P0.8 | Caixa aberto (status) | `GET /api/caixa/aberto` | **Manter** badge 05.23 |
| P0.9 | Middleware caixa | `validarCaixaSeOrigemPdv` no checkout | **Manter** (backend já bloqueia) |
| P0.10 | TEF pagar | `POST /api/tef/pagar` + `TefManager` | **Manter** `pdv-universal-tef.js` |
| P0.11 | PIX cobrança/status | `POST/GET /api/pix/*` | **Manter** `pdv-universal-pix.js` |
| P0.12 | Flag produto pesável | `produto_fracionado` / `produto_pesavel` | **Manter** do produto normalizado |
| P0.13 | Pesagem manual UI | modal PESAR 05.29 | **Manter** |
| P0.14 | Comprovante unificado MUV | `GET .../comprovante` + `ComprovanteUnificadoAtendimentoService` | **Manter** |
| P0.15 | Impressão browser MUV | `POST /api/atendimentos/:id/imprimir` + `ComprovantePrintService` | **Manter** |
| P0.16 | Contexto operacional | `GET/PUT /api/pdv-universal/contexto` | **Manter** |

---

## P1 — EXISTE MAS PRECISA ADAPTAÇÃO

Pequena extração ou wiring — **sem motor novo**.

| # | Recurso | Gap | Adaptação sugerida |
|---|---------|-----|-------------------|
| P1.1 | `tefFluxoPagamento.js` | Universal não importa; tipos duplicados em `pdv-universal-tef.js` | Importar `frontend/shared/js/tefFluxoPagamento.js`; delegar normalização |
| P1.2 | `GET /api/tef/fluxo-pdv` | URL exportada, nunca chamada | Chamar no boot Universal (como legado) para gates PIX-TEF/fiscal |
| P1.3 | Etiqueta balança | Backend `POST /api/equipamentos/etiquetas/interpretar` pronto | Chamar de `identificarEntradaPdv` quando EAN-13 prefixo 2; aplicar peso ao cart |
| P1.4 | Peso meta MIP | `meta.peso` ignorado (qty=1) | Usar meta após identificar quando `produto_fracionado=1` |
| P1.5 | `POST /api/tef/cancelar` | Universal não cancela TEF ao abortar | Chamar no cancelamento de venda/TEF pendente |
| P1.6 | Desconto supervisor | `POST /api/auth/supervisor/authorize` | Reutilizar modal/pattern legado quando desconto exceder limite |
| P1.7 | Motor preço atacado | `motor-preco-atacado.js` no legado | Importar no Universal para paridade desconto automático |
| P1.8 | Pré-cálculo F×NF | `POST /api/vendas/pre-calcular-distribuicao` | Conectar preview fiscal antes checkout EMPRESA_UNICA se necessário |
| P1.9 | Pagamento não-fiscal 2ª etapa | rotas `/pagamento-nao-fiscal` | Avaliar paridade pós-fiscal legado |
| P1.10 | Impressão térmica | `ThermalPrintAdapter` no backend | Passar `destino: THERMAL` quando estação configurada |
| P1.11 | DANFE pós-venda EMPRESA_UNICA | legado usa `fiscalImpressao.js` | Reutilizar helpers compartilhados ou fiscalizar via rota existente |
| P1.12 | `GET /api/pix/config` | Universal não consulta | Opcional: gate PIX antes de criar cobrança |

---

## P2 — DUPLICAÇÕES

Código que **não deve permanecer em paralelo** indefinidamente.

| # | Duplicação | Legado | Universal | Direção |
|---|------------|--------|-----------|---------|
| P2.1 | Entry checkout venda | `POST /api/vendas` | `POST /api/pdv-universal/checkout` | Universal oficial; legado temporário até desativação |
| P2.2 | Carrinho in-memory | `carrinho[]` em pdv.js | `PDVUniversalCart` | Universal oficial; legado obsoleto com migração |
| P2.3 | Cálculo total/desconto | lógica espalhada pdv.js | `calcularTotaisOperacionais` | Consolidar no Universal; extrair shared se legado persistir |
| P2.4 | Adapter PIX front | funções em pdv.js | `pdv-universal-pix.js` | Extrair `shared/js/pixFluxoPagamento.js` (espelho TEF) |
| P2.5 | Tipos/normalização TEF | `tefFluxoPagamento.js` | cópia parcial em `pdv-universal-tef.js` | Unificar em shared |
| P2.6 | Dois núcleos venda mesmo motor | vendas.js vs pdv-universal checkout | Convergem em `VendaPagamentoService` | Documentar; não criar terceiro caminho |

---

## P3 — AUSÊNCIAS REAIS

Comprovadamente **não existem** no sistema (no escopo auditado).

| # | Recurso | Evidência |
|---|---------|-----------|
| P3.1 | Entrega no PDV Universal | Zero referências em `frontend/pdv-universal/` |
| P3.2 | Pagamento misto no Universal (balcão EMPRESA_UNICA) | Sem `abrirPagamentoMisto` equivalente |
| P3.3 | Pagamento a prazo no Universal | Sem modal cliente prazo |
| P3.4 | TEF/PIX multiempresa no Universal | Gates explícitos `*_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADO` |
| P3.5 | Fechamento caixa UI Universal | Botão disabled, sem handler |
| P3.6 | Balança física contínua no Universal | Sem driver/protocolo no front Universal |
| P3.7 | Voucher pagamento Universal | Existe só em prestação entrega legado |

**Nota:** entrega, caixa operacional, TEF multiempresa têm **backend legado pronto** — classificados como P1/P4 (conectar), não P3.

---

## Ordem recomendada de integração (pós-auditoria)

1. **P1.1 + P1.2** — TEF fluxo compartilhado (baixo risco, alto alinhamento)
2. **P1.3 + P1.4** — Etiqueta/peso no carrinho (backend pronto)
3. **P1.5** — Cancel TEF no abort Universal
4. **Entrega P1** — Conectar `pdv-venda-entrega` APIs ao Universal (sem novo backend)
5. **Caixa P1** — UI abrir/fechar/sangria reutilizando `caixa.js` APIs
6. **P1.7** — Atacado/desconto automático
7. **PIX-TEF / misto / prazo** — após fluxo-pdv compartilhado
8. **TEF/PIX multiempresa** — sprint dedicada MUV
9. **Balança física** — sprint equipamentos (motor existe, PDV desconectado)

---

## O que NÃO recriar (decisão de arquitetura)

| Componente | Motivo |
|------------|--------|
| `VendaPagamentoService.criarVenda` | Núcleo oficial EMPRESA_UNICA |
| `TefManager` / `POST /api/tef/pagar` | Motor TEF oficial |
| `pixService` | Motor PIX oficial |
| `LayoutEtiquetaService` | Interpretação etiqueta oficial |
| `AtendimentoMultiempresaService` | Motor MUV oficial |
| `ComprovantePrintService` | Impressão unificada MUV |
| `EntregaService` + rotas `/vendas/entregas/*` | Entrega operacional completa |
| `FechamentoCaixaResumoService` | Caixa backend completo |
