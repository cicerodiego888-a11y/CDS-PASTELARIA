# Auditoria de prontidão — PDV Universal (Sprint 04.14)

**Decisão:** **B — PRONTO COM PENDÊNCIAS NÃO BLOQUEADORAS**

**05.01 pode começar?** **SIM.** A fundação de backend não precisa ser reinventada no meio da Fase 05. Wrappers HTTP do ciclo MULTIEMPRESA (reserva → pagamento → materialização → fiscalização) são trabalho de fachada previsto para 05.06–05.08, não reescrita de motor.

Nenhuma alteração de produção nesta sprint.

---

## Matriz da Fase 05

| Sprint Fase 05 | Backend | Contrato | HTTP | Bloqueador | Status |
|----------------|---------|----------|------|------------|--------|
| 05.01 Fundação do PDV Universal | Serviços + modo + empresas | Sim | Modo só via config avançada (SuperAdmin) | Não | PRONTO_COM_PENDENCIA |
| 05.02 Contexto operacional e seleção de empresa | EmpresaService + contexto | Sim | GET/POST `/api/empresas/contexto*` e `?ativo=` | Não | PRONTO |
| 05.03 Nova tela principal | Não exigido no backend | N/A (UI) | Reusa catálogo/PDV atuais | Não | PRONTO |
| 05.04 Carrinho universal | Itens exigem `produtoId`+`empresaId` | Sim (agrupa no MUV) | Sem “resolver empresa pelo produto” | Não | PRONTO_COM_PENDENCIA |
| 05.05 Checkout EMPRESA_UNICA | VendaApplication → VendaPagamento | Sim | `POST /api/vendas` | Não | PRONTO |
| 05.06 Checkout MULTIEMPRESA | criar/reservar/obter no serviço | Sim | Só cria via `POST /api/vendas` (modo MULTIEMPRESA). Sem rotas de reserva | Não | PRONTO_COM_PENDENCIA |
| 05.07 Pagamento + MUV | `confirmarPagamentoAtendimento` | POR_ITEM / PROPORCIONAL / MANUAL | Sem POST pagamento | Não | PRONTO_COM_PENDENCIA |
| 05.08 Fiscalização + comprovante | Fiscalizar + DTO 04.10 | Status + retry no serviço | GET comprovante existe; POST fiscalizar não | Não | PRONTO_COM_PENDENCIA |
| 05.09 Preview + impressão | PrintService 04.12 + UI 04.13 | JSON/TEXT/HTML + PREVIEW/BROWSER/THERMAL | GET comprovante + POST imprimir | Não | PRONTO |

---

## Bloco A — Modo de operação

| Item | Evidência |
|---|---|
| Serviço | `configuracaoService.obterModoOperacaoVenda` |
| Resolução operacional | `resolverModoOperacaoVendaAtivo` — **não** lê body/query/CNPJ |
| Despacho | `executarNoModoOperacaoVenda` — MULTIEMPRESA sem executor **não** cai no legado |
| Inválido | `MODO_OPERACAO_VENDA_INVALIDO` |
| Porta | `VendaApplicationService.criarVenda` |
| HTTP consulta | `GET /api/configuracoes-avancadas` (`readConfig`, **exigirSuperAdmin**) inclui `modo_operacao_venda` |
| HTTP alteração | `POST /api/configuracoes-avancadas` (SuperAdmin) + `validateConfig` |

**Lacuna (não bloqueadora):** não há `GET` autenticado “leve” só com o modo para o operador de caixa. A 05.01/05.02 pode expor `obterModoOperacaoVenda()` sem abrir o JSON administrativo inteiro.

---

## Bloco B — Empresas e contexto

| Pergunta | Resposta |
|---|---|
| API segura de listagem? | Sim: `GET /api/empresas` (token), `GET /api/empresas/contexto/disponiveis` |
| Seletor visual? | Sim: `id`, `cnpj`, `razao_social`, `nome_fantasia`, `ativo` |
| Filtrar inativas? | `GET /api/empresas?ativo=` |
| Contexto confiável? | `GET/POST /api/empresas/contexto` + middleware `empresaContexto` |
| empresa_id no body indevido? | Item MUV: `empresa_id`/CNPJ/nome **não** substituem `empresaId`. Fiscal admin: body divergente → `EMPRESA_CONFIGURACAO_DIVERGENTE` |
| Autoridade do empresaId | Persistido nas **operações** pelo backend a partir do item oficial `empresaId`. Contexto de sessão para EMPRESA_UNICA / estoque HTTP. |

**Classificação:** PRONTO

---

## Bloco C — Catálogo e identificação

Produto é compartilhado. Estoque é `estoque_empresa`.

Busca, código, código de barras e PLU existem em `rotas/produtos` e no PDV atual.

**Pergunta crítica:** o sistema **não** infere empresa pelo produto. O contrato MUV exige `empresaId` explícito no item. Identificação automática da 05.04 = regra de UI/contexto (empresa selecionada, ou escolha entre empresas com saldo), **não** cópia de produto.

**Lacuna (não bloqueadora):** não há endpoint “empresas com saldo deste produto”. A UI pode consultar `reservasPublico.consultarDisponibilidade(produtoId, { empresaId })` por empresa listada, ou a 05.04 adicionar um agregador fino.

---

## Bloco D — Estoque

Com `empresaId`: `estoque_empresa`. Sem registro → saldos **0** (`reservasPublico`). Sem `empresaId`: COMPAT em `produtos` apenas quando o contexto legado é explícito. MUV valida por `item.empresaId`. Saldo global **não** autoriza outra empresa.

**Classificação:** PRONTO

---

## Bloco E — Carrinho

Entrada MULTIEMPRESA: `{ origem, itens: [{ produtoId, empresaId, quantidade, valorUnitario, tipoFiscal? }] }`.

Backend valida, agrupa por empresa, cria atendimento. Frontend **não** rateia nem decide estoque.

EMPRESA_UNICA: contrato atual de `POST /api/vendas` / `VendaContract`.

**Diferença:** carrinho universal interno usa `empresaId`; venda única usa o fluxo legado sem atendimento.

---

## Bloco F — Checkout EMPRESA_UNICA

`PDV → POST /api/vendas → VendaApplicationService → VendaPagamentoService`.

Sucesso: `venda_id`, pagamento, NFC-e/DANFE existentes. Sem atendimento inventado.

**Classificação:** PRONTO — a 05.05 reutiliza, não duplica.

---

## Bloco G — Checkout MULTIEMPRESA

| Etapa | Serviço | HTTP hoje | Entrada / saída |
|---|---|---|---|
| 1. Criar | `criarAtendimento` via `criarVenda` se modo MULTIEMPRESA | `POST /api/vendas` | itens → `atendimentoId`, `VALIDADO`, `venda_concluida: false` |
| 2. Reservar | `reservarAtendimento` | **ausente** | id → `RESERVADO` |
| 3. Pagar | `confirmarPagamentoAtendimento` | **ausente** | pagamentos + estratégia → `PAGO` + rateios |
| 4. Materializar | `materializarAtendimento` | **ausente** | id → vendas por empresa, `CONCLUIDO` |
| 5. Fiscalizar | `fiscalizarAtendimento` | **ausente** | id → FISCALIZADO / PARCIAL / ERRO |
| 6. Comprovante | `obterComprovanteUnificado` | `GET /api/atendimentos/:id/comprovante` | JSON/TEXT/HTML |
| 7. Imprimir | `imprimirComprovante` | `POST /api/atendimentos/:id/imprimir` | destino/formato/largura |

Status e erros já existem nos serviços (`SALDO_INSUFICIENTE`, `EMPRESA_OBRIGATORIA`, modo inválido, etc.).

**Não é bloqueador da 05.01:** a UI fundacional não executa o ciclo completo. A 05.06 deve acrescentar rotas finas que **delegam** aos métodos acima — sem segundo motor.

---

## Bloco H — Pagamento e rateio

Contrato 04.05: 1..N pagamentos, total oficial, tolerância 0,01, POR_ITEM / PROPORCIONAL / MANUAL, idempotência e rateio por empresa no backend. UI da 05.07 envia formas + valores + estratégia.

---

## Bloco I — Fiscalização

`FiscalizarAtendimentoService` + `empresas_configuracao_fiscal` + `nfce_notas.empresa_id` + `atendimento_operacao_documentos`. Cada empresa: config e NFC-e próprias. Status: pendente / autorizado / parcial / erro + retry sem reemitir AUTORIZADA. Acompanhamento visual: DTO do comprovante (`fiscal.status`, `documentos_fiscais`). GET status admin: `/api/empresas/configuracao-fiscal/status`. Segredos mascarados no DTO público.

HTTP de **disparo** da fiscalização: pendência 05.08.

---

## Bloco J — Comprovante e impressão

Um comprovante, itens contínuos, um total, pagamento unificado, empresas só na área fiscal. Destinos PREVIEW / BROWSER / THERMAL (preparado). UI 04.13 consome a API. Sem três comprovantes.

---

## Bloqueadores

Nenhum bloqueador de fundação.

## Pendências não bloqueadoras

1. GET dedicado do modo para o PDV (operador ≠ SuperAdmin).
2. Rotas HTTP de reservar / pagar / materializar / fiscalizar / obter atendimento.
3. Identificação de empresa no carrinho é contextual (`empresaId` obrigatório), não automática pelo SKU.
4. THERMAL sem ESC/POS físico (já conhecido; 05.09 usa BROWSER/PREVIEW).
