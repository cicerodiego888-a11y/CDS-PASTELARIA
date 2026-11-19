# PLANEJAMENTO TÉCNICO — Sprint 07 · Interface Operacional da Cozinha (KDS)

**Projeto:** CDS Pastelaria  
**Responsável (planejamento):** Cursor  
**Direção técnica:** ChatGPT — Tech Lead  
**Escopo autorizado nesta entrega:** auditoria + planejamento — **sem implementação**  
**Data:** 2026-11-17  

**Referências:**  
- `Agent/AUDITORIA-HOMOLOGACAO-VISUAL-CDS-PASTELARIA.md`  
- `Agent/CONFERENCIA-ROADMAP-COZINHA-POS-S05.md`  
- `Agent/auditoria-sprint06-impressao/ENCERRAMENTO-SPRINT06-APROVADO.md` (Sprint 06 congelado)  
- Schema: `backend/utils/cozinhaSchema.js` (v3)  
- Rotas: `backend/rotas/cozinha.js`  

---

## 1. Diagnóstico da arquitetura existente

### 1.1 O que já existe (código real)

| Camada | Situação |
|--------|----------|
| Schema Cozinha **v3** | Tabelas `cozinha_unidades`, `comandas`, `rodadas`, `itens`, idempotência, outbox, notificações, fila/estações impressão |
| Despacho | `CozinhaDespachoService.despacharLote` + `POST /api/cozinha/despacho` |
| Preparação | `iniciarPreparacao`, `marcarItemPronto`, `entregarBebida`, `consultarPreparacaoRodada` |
| Isolamento | Empresa via `criarMiddlewareContextoEmpresa` + `empresaIdDoReqPedido`; unidade via JWT `unidade_cozinha_id` nas mutações de item |
| Recurso implantação | `router.use(exigirRecurso('pedidos'))` em todas as rotas Cozinha |
| Impressão (S06) | Estações/fila/worker Electron — **fora do escopo visual do S07** (congelado) |
| Frontend ERP | Shell `data-page` + `loadPage` em `frontend/erp/js/app.js` — **sem** página KDS |
| Preparação ERP Mesas | `POST /api/pedidos/:id/preparacao/enviar` — **não** chama despacho Cozinha |

### 1.2 Lacuna crítica para um KDS utilizável

**Não existe endpoint de listagem do painel** (rodadas/itens abertos da unidade).

Disponível hoje para leitura operacional:

- `GET /api/cozinha/rodadas/:id/preparacao` — exige **já conhecer** o `rodada_id`.

Sem listagem, a UI não consegue montar o quadro “aguardando / em preparação / concluídos” a partir do backend sem inventar IDs ou varrer dados fora do contrato.

### 1.3 Lacuna de abastecimento de pedidos

O botão **“Enviar pedido para cozinha”** (Mesas/Pedidos) grava preparação no domínio ERP (`PedidoPreparacaoService`).  
Documentado como pendência pré-Cozinha: **não há dual-write automático** ERP → `CozinhaDespachoService`.

Consequência: mesmo com KDS, a tela ficará **vazia** se ninguém chamar `POST /api/cozinha/despacho` com itens reais.  
O S07 **não deve simular** recebimento. O planejamento precisa de um bloco explícito (aprovação PO/TL) para:

- **Opção A (mínima S07):** endpoint de board + UI; despacho permanece API/teste até integração ERP; ou  
- **Opção B (recomendada para homologação visual útil):** gancho controlado Mesas/Pedidos → `despacharLote` (sem alterar S06; sem schema novo), sob autorização separada.

### 1.4 Tempo real

- `cozinha_eventos_outbox` / `cozinha_notificacoes` existem no schema e recebem inserts na preparação.  
- **Não há** SSE, WebSocket nem polling HTTP público de outbox no `server.js` / rotas Cozinha.  
- Atualização do KDS na V1: **polling** HTTP (intervalo curto) sobre o futuro endpoint de board.

### 1.5 Autenticação / unidade

- Login (`backend/rotas/auth.js`) **pode** embutir `unidade_cozinha_id` no JWT se o body enviar e `cozinhaAuthUnidade` validar.  
- Frontend de login (`frontend/shared/login*`) **não** coleta `unidade_cozinha` hoje.  
- Mutações `iniciar` / `pronto` / `bebida` exigem unidade na sessão (`resolverUnidadeOperacionalReq`).  
- `GET /rodadas/:id/preparacao` hoje filtra por **empresa**, não revalida unidade na rota (risco a corrigir no board novo).

---

## 2. Contratos reais das APIs disponíveis

Base: `app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes)`.

| Método | Rota | Função | Observação para KDS |
|--------|------|--------|---------------------|
| GET | `/status` | Schema operacional + versão | Health do módulo |
| POST | `/despacho` | Cria rodada/itens (FIFO) | Entrada de trabalho — **não é UI KDS** |
| POST | `/itens/:id/iniciar` | AGUARDANDO → EM_PREPARACAO | Ação KDS |
| POST | `/itens/:id/pronto` | EM_PREPARACAO → PRONTO | Ação KDS (exige iniciar antes) |
| POST | `/itens/:id/bebida/entregar` | Entrega parcial/total BEBIDA | Fora do foco “Retirada/Garçom”; usar com cautela no S07 |
| GET | `/rodadas/:id/preparacao` | Detalhe de uma rodada | Útil após listagem |
| GET/POST/PUT | `/impressao/estacoes*` | CRUD/teste estação | **Fora S07** |
| GET | `/impressao/fila*` | Consulta fila | **Fora S07** |
| POST | `/impressao/fila/:id/reenviar` | Reenvio | **Fora S07** |
| POST | `/impressao/snapshot/preview` | Preview texto | **Fora S07** |

### 2.1 Idempotência

Mutações aceitam `Idempotency-Key` (header) ou `idempotency_key` / `chave_idempotencia` (body).  
KDS deve gerar chave por ação (ex.: `kds-iniciar-{itemId}-{operatorAttempt}`) e repetir com segurança em retry.

### 2.2 Payload útil de `consultarPreparacaoRodada`

Retorna `rodada` (`mesa_id`, `atendimento_id`, `numero_rodada`, `sequencia_global`, estados), `itens[]` via `dtoItem` + `ingredientes` + `entrega_bebida` (se BEBIDA), `conclusao`, `bebidas`.

**Limitações do DTO atual (`dtoItem`):**

- Inclui: `id`, `comanda_id`, `pedido_id`, `tipo_item`, estados, qtys, `produto_id`, `produto_nome_snapshot`.  
- **Não inclui** no DTO: `observacoes_snapshot` (coluna existe no schema).  
- **Não inclui** `numero_comanda` (só `comanda_id`; número está em `cozinha_comandas`).  
- **Não inclui** rótulo/número de mesa amigável (só `mesa_id`).

Para a UI prevista no brief, o board precisará **enriquecer** a resposta (join comanda + mesa) — preferencialmente no novo endpoint de listagem, **sem** mudar schema v3.

---

## 3. Estados de preparação e transições

### 3.1 Item (`cozinha_itens.estado_preparacao`)

| Estado | Significado |
|--------|-------------|
| `AGUARDANDO` | Despachado, ainda não iniciado |
| `EM_PREPARACAO` | Em preparo |
| `PRONTO` | Item pronto |
| `CANCELADO` | Cancelado (sem transição de volta pelas APIs de preparação) |

**Transições permitidas (serviço):**

```
AGUARDANDO --[iniciar]--> EM_PREPARACAO --[pronto]--> PRONTO
EM_PREPARACAO --[iniciar idempotente]--> EM_PREPARACAO (ja_em_preparacao)
PRONTO --[pronto idempotente]--> PRONTO (ja_pronto)
AGUARDANDO --[pronto]--> 409 TRANSICAO_INVALIDA (“Inicie a preparação…”)
CANCELADO --[*]--> 409 ITEM_CANCELADO
```

Bebida: `entregarBebida` pode zerar saldo e marcar item `PRONTO` sem passar pelo fluxo pastel clássico.

### 3.2 Rodada (`cozinha_rodadas.estado_preparacao`)

| Estado | Significado |
|--------|-------------|
| `AGUARDANDO` | Nenhum item relevante iniciado |
| `EM_PREPARACAO` | Ao menos um item em preparo/pronto (sync) |
| `PRONTA` | Regra de conclusão: com PASTEL → todos PASTEL `PRONTO`; sem PASTEL → OUTROs `PRONTO`. **BEBIDA não bloqueia `PRONTA`.** |
| `CANCELADA` | Bloqueada |

`retirada_estado` / `entrega_estado` existem no schema — **fora do S07** (Retirada/Garçom).

### 3.3 Tipos de item

`PASTEL` | `BEBIDA` | `OUTRO` — classificação no despacho; UI deve distinguir visualmente.

---

## 4. Proposta de navegação e acesso ao KDS

### 4.1 Entrada recomendada (ERP)

| Item | Proposta |
|------|----------|
| Menu | Grupo **Comercial** (ou novo grupo **Cozinha**): item **“Cozinha (KDS)”** |
| `data-page` | `cozinha-kds` |
| Permissão | Reutilizar recurso `pedidos` (já exige nas APIs) + `usuarioTemPermissao` alinhado a `pedidos` |
| URL | `/erp` → clique no menu → `loadPage('cozinha-kds')` (padrão atual, sem SPA router novo) |

### 4.2 Sessão com unidade

Sem `unidade_cozinha_id` no JWT, mutações falham com `UNIDADE_OBRIGATORIA`.

**Proposta S07 (mínima):**

1. Na abertura do KDS, se a sessão não tiver unidade: modal/seleção de **unidade de cozinha autorizada** (lista via endpoint a definir ou reuso de cadastro) → **re-login** ou endpoint de “troca de contexto” **somente se TL autorizar** (hoje o caminho seguro é relogar com `unidade_cozinha_id` no body do login).  
2. Alternativa: campo opcional no login web (escopo auth UI) — declarar como bloco à parte.

### 4.3 O que **não** fazer

- Não acoplar KDS ao `/pdv` nem PDV Universal.  
- Não colocar atalho dentro de impressão comercial (`impressora_cupom`).  
- Não usar fila S06 como “lista de pedidos” do KDS.

---

## 5. Proposta de organização visual da tela

Idioma: **português brasileiro**. Layout operacional (TV/tablet cozinha), não dashboard administrativo.

### 5.1 Estrutura (uma composição, três colunas/faixas)

| Faixa | Conteúdo |
|-------|----------|
| Cabeçalho | Título “Cozinha”, unidade, empresa, relógio, botão atualizar, estado conexão |
| **Aguardando** | Cards de rodadas/itens `AGUARDANDO` (FIFO por `sequencia_global`) |
| **Em preparação** | Cards `EM_PREPARACAO` |
| **Prontos / concluídos** | Itens `PRONTO` e/ou rodadas `PRONTA` (janela curta, ex. últimas N ou últimas X horas) |

### 5.2 Card (mínimo)

- Mesa / atendimento / comanda / nº rodada / horário (`enviada_em` ou `created_at`)  
- Lista de itens: nome snapshot, qtd, tipo (PASTEL/BEBIDA/OUTRO), observações  
- Ações: **Iniciar** / **Pronto** (por item; desabilitar conforme estado)  
- Erros de API em banner no card ou toast claro (`mensagem`/`codigo`)

### 5.3 Regras de UX alinhadas ao backend

- Não oferecer “Pronto” se item ainda `AGUARDANDO`.  
- Não inventar pedido sem despacho.  
- Falha de impressão **não aparece** como bloqueio de preparação (S06 separado).  
- Sem campos de preço, pagamento ou fiscal.

---

## 6. Componentes frontend necessários

| Componente (lógico) | Responsabilidade |
|---------------------|------------------|
| `loadCozinhaKds` | Entry `loadPage` — monta shell HTML |
| Cliente API Cozinha | `fetch` autenticado `/api/cozinha/...` + Idempotency-Key |
| Store/painel em memória | Map por `rodada_id`/`item_id` — merge no poll (sem duplicar) |
| Coluna/lista KDS | Render das três faixas |
| CardRodada / CardItem | Exibição + botões |
| Barra status / erros | Offline, 503 `COZINHA_NAO_OPERACIONAL`, 409 isolamento |
| Seletor unidade (se necessário) | Antes de operar |

Padrão: JS vanilla + Bootstrap já usados no ERP (`frontend/erp/js/*.js`), lazy via `CDS_ERP_PAGE_SCRIPTS`.

---

## 7. Arquivos a criar ou modificar (proposta — **não executar agora**)

### 7.1 Criar (frontend)

| Arquivo | Motivo |
|---------|--------|
| `frontend/erp/js/cozinha-kds.js` | UI + poll + ações |
| (opcional) `frontend/css/cozinha-kds.css` | Layout operacional |

### 7.2 Modificar (frontend — após aprovação)

| Arquivo | Mudança |
|---------|---------|
| `frontend/erp/index.html` | Item de menu Cozinha (KDS) |
| `frontend/erp/js/app.js` | `CDS_ERP_PAGE_SCRIPTS.cozinha-kds` + `case 'cozinha-kds'` |
| `frontend/shared/js/access-control.js` | Mapear página → permissão `pedidos` / vendas conforme padrão |
| (opcional) `frontend/shared/js/login.js` + login HTML | Envio de `unidade_cozinha_id` |

### 7.3 Backend necessário para o board (recomendado — autorização TL)

| Arquivo | Mudança proposta |
|---------|------------------|
| `backend/services/cozinha/CozinhaPreparacaoService.js` (ou serviço `CozinhaKdsConsultaService.js` **novo**) | `listarPainelPreparacao({ empresaId, unidadeId, estados, limite })` |
| `backend/rotas/cozinha.js` | `GET /preparacao/painel` (nome a validar) — **somente leitura**, filtro empresa+unidade JWT |
| Testes `tests/cozinha/sprint07-*.test.js` | Contratos do painel + regressão S01–S06 |

**Proibido sem autorização:** alterar schema v3, S06 worker/fila/estações, PDV, fiscal.

### 7.4 Integração despacho (opcional, bloco separado)

| Arquivo | Mudança |
|---------|---------|
| `PedidoPreparacaoService` / rota pedidos | Após sucesso ERP, chamar `despacharLote` **ou** endpoint orquestrador — só com brief PO |

---

## 8. Dependências e riscos

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Sem `GET` painel | KDS inviável | Bloco 0 backend consulta (este plano) |
| Sem dual-write ERP→despacho | Painel vazio na operação real | Bloco integração ou dados via API de teste controlada |
| JWT sem unidade | Mutações 400 | Login/contexto unidade no KDS |
| `dtoItem` sem observações/comanda nº | UI incompleta | Enriquecer no serviço de painel |
| Polling agressivo | Carga SQLite | Intervalo 2–5s + ETag/`updated_at` se TL autorizar |
| Confundir com impressão S06 | Regressão / spooler | Zero UI de fila/estação no S07 |
| `entregarBebida` no KDS | Escopo Retirada | Adiar botão “entregar bebida” ou marcar como fase 2 |
| GET rodada sem check unidade | Vazamento entre unidades | Novo endpoint com `unidadeCozinhaDaSessao` obrigatório |
| Dependência circular estoque | Ruído em logs | Pendência independente — não bloquear S07 |

---

## 9. Plano de implementação em blocos pequenos

> **Nenhum bloco inicia sem aprovação do Tech Lead + Product Owner.**

| Bloco | Entrega | Depende |
|-------|----------|---------|
| **S07-0** | `GET` painel preparação (empresa+unidade; estados; joins comanda/mesa/obs) + testes API | Aprovação TL (backend leitura) |
| **S07-1** | Menu + `loadPage('cozinha-kds')` + shell vazio + health `/status` | S07-0 ou mock se TL permitir UI first |
| **S07-2** | Render colunas + poll + merge sem duplicar | S07-0, S07-1 |
| **S07-3** | Ações Iniciar / Pronto + Idempotency-Key + erros 409/503 | S07-2 |
| **S07-4** | Contexto unidade (login ou modal) | S07-3 |
| **S07-5** | (Opcional PO) Dual-write / orquestração despacho a partir de Mesas | Brief separado |
| **S07-6** | Regressão S01–S06 + checklist aceite | Todos acima |

**Fora da sprint:** estações, fila, spooler, física, Retirada/Garçom, Android.

---

## 10. Plano de testes

### 10.1 Automatizados (banco temporário, `CDS_BLOQUEAR_BANCO_OFICIAL=1`)

| ID | Caso |
|----|------|
| T-API-01 | Painel lista só empresa/unidade da sessão |
| T-API-02 | Painel não retorna outra unidade |
| T-API-03 | Itens AGUARDANDO / EM_PREPARACAO / PRONTO filtráveis |
| T-API-04 | Iniciar + Pronto respeitam transições; replay idempotente |
| T-API-05 | Pronto sem iniciar → 409 |
| T-API-06 | Sem unidade no JWT → mutação 400 |
| T-UI-01 | (jsdom ou teste de contrato do cliente) merge de poll sem duplicar IDs |
| T-REG | Suíte cozinha S01–S06 inalterada (fail=0) |

### 10.2 Funcionais manuais (sem impressão física)

1. Garantir schema operacional (`GET /status`).  
2. Despachar lote de teste via API (ou bloco S07-5).  
3. Abrir KDS no ERP → ver card.  
4. Iniciar → mover para “Em preparação”.  
5. Pronto → “Prontos”; rodada pode ir a `PRONTA` conforme regra PASTEL.  
6. Simular falha de rede → mensagem clara; retry idempotente.  
7. Confirmar que PDV/fiscal/S06 não foram tocados.

---

## 11. Critérios objetivos de aceite (S07)

1. Existe item de menu **Cozinha (KDS)** no ERP e página `cozinha-kds` carregável.  
2. Operador com recurso `pedidos` e JWT com `unidade_cozinha_id` visualiza rodadas/itens **despachados** da sua unidade.  
3. Colunas (ou equivalente) cobrem aguardando, em preparação e concluídos recentes.  
4. Card exibe mesa/atendimento/comanda/horário/itens/qtd/observações (quando presentes no contrato enriquecido).  
5. **Iniciar** e **Pronto** usam APIs reais; estados batem com o backend; sem estados inventados.  
6. Polling atualiza sem duplicar cards nem “ressuscitar” itens cancelados.  
7. Erros de comunicação exibidos em português com código quando houver.  
8. Nenhuma alteração em PDV oficial, PDV Universal, S06 (worker/fila/estações), schema v3, fiscal ou valores financeiros.  
9. Falha de impressão **não** é pré-requisito nem bloqueio da preparação na UI.  
10. Testes automatizados do bloco + regressão cozinha S01–S06 com `TOTAL_FAIL: 0`.  
11. Homologação física / spooler real **não** fazem parte do aceite S07.

---

## 12. Decisões que o Tech Lead / PO precisam tomar antes da implementação

1. Autorizar **S07-0** (`GET` painel) — obrigatório para KDS honesto.  
2. Autorizar ou adiar **S07-5** (ERP → despacho). Sem isso, homologação visual depende de despacho manual via API.  
3. Escopo de **bebida/entregar** no KDS V1: incluir ou adiar.  
4. Como o operador obtém `unidade_cozinha_id` no login web.  
5. Confirmar nome da rota (`/preparacao/painel` vs outro) e se recurso permanece `pedidos`.

---

## 13. Status desta entrega

| Item | Status |
|------|--------|
| Auditoria de APIs/serviços/schema/frontend | Concluída (somente leitura) |
| Documento `Agent/PLANEJAMENTO-SPRINT07-KDS.md` | Entregue |
| Implementação de produto | **Não autorizada / não iniciada** |
| Sprint 06 | **Preservado / congelado** |

**Aguardando avaliação do Tech Lead e aprovação do Product Owner para qualquer bloco de implementação.**
