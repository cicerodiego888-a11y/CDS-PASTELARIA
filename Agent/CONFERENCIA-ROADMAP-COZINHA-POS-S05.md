# CONFERÊNCIA DE ROADMAP — Módulo Cozinha (pós Sprint 05)

**Projeto:** CDS Sistemas — Pastelaria  
**Responsável:** Cursor  
**Solicitante:** Tech Lead  
**Data:** 2026-11-16  
**Escopo desta entrega:** somente leitura e relatório.  
**Status:** AGUARDANDO AVALIAÇÃO DO TECH LEAD  

**Restrições cumpridas:** nenhuma implementação · nenhum arquivo de produção alterado · nenhuma migration · banco oficial intocado · Sprint 06 **não** iniciada.

---

## Legenda de origem (obrigatória)

| Selo | Significado |
|---|---|
| **DOCUMENTADO** | Encontrado em contrato, brief de sprint, revisão arquitetural ou pacote de auditoria |
| **CÓDIGO** | Comprovado no repositório atual (`backend/`, `tests/cozinha/`) |
| **RECOMENDAÇÃO** | Inferência técnica a partir do planejamento original + estado real — **não** é autorização |

---

## 1. Planejamento original encontrado

### 1.1 Fontes localizadas

| Fonte | Onde | Natureza |
|---|---|---|
| Contrato técnico Cozinha V1.0 | Brief do Tech Lead (sessão 2026-11-16) | **DOCUMENTADO** — arquitetura funcional em 4 níveis |
| Revisões V1.1 → V1.2 → V1.2.1 → V1.2.3 + adendos de idempotência/hash | Briefs + canvases `cozinha-v1-*.canvas.tsx` | **DOCUMENTADO** — arquitetura congelada para implementação |
| Pré-Cozinha (Mesas) | `docs/arquitetura/MESAS-AUDITORIA-FINAL-PRÉ-COZINHA.md` | **DOCUMENTADO** — aprovação B para iniciar integração técnica |
| Briefs de implementação | S01, S02, S03, S04A, S05 (sessão 2026-11-16) | **DOCUMENTADO** — sequência autorizada de sprints |
| Pacotes `Agent/auditoria-sprint0*` | S02, S03, S04A, S05 (+ S01 no Agent Store) | **DOCUMENTADO** — evidências de entrega/homologação |
| Auditoria modelo de produtos | `Agent/auditoria-cozinha-modelo-produtos/` | **DOCUMENTADO** — classificação PASTEL/BEBIDA/OUTRO (pré-S03) |

**Não foi encontrado** um documento único intitulado “roadmap de sprints Cozinha” com objetivos explícitos de S06+. A sequência abaixo é a **reconstrução factual** dos briefs autorizados e do contrato.

### 1.2 Sequência original de desenvolvimento (reconstruída)

**DOCUMENTADO** — ordem em que as sprints foram autorizadas e executadas:

| Ordem | Sprint | Objetivo documentado |
|---|---|---|
| 0 | Pré-requisito Mesas | Aprovado com pendências não bloqueantes para desenhar Cozinha |
| 1 | **S01** | Fundação de persistência V1.2.3 (schema, hash, milésimos, idempotência) |
| 2 | **S02** | Despacho de comandas, rodada, FIFO |
| 3 | **S03** | Motor de preparação e controle de rodadas (+ classificação operacional) |
| 4 | **S04A** | Upgrade seguro schema Cozinha v2 → v3 (CHECK/tipos de idempotência) |
| 5 | **S05** | Operações/transições dos itens + isolamento operacional por unidade (homologação) |

**Observação documental:** não houve brief de “Sprint 04” de produto entre S03 e S05. A sprint técnica emitida foi **04A** (migração de schema).

### 1.3 Arquitetura funcional original (Contrato V1.0)

**DOCUMENTADO** — quatro níveis:

1. **Operação de atendimento existente** — mesas, pedidos, personalização, ERP (reutilizar).
2. **Camada de despacho** — comanda, rodada, sequência FIFO, registro de despacho.
3. **Camada de cozinha** — fila, impressão, preparação por item, quantidades, item pronto, liberação da rodada.
4. **Camada de comunicação** — notificar garçons, retirada, entrega, bebidas antecipadas, histórico, futuro Android/KDS.

Objetivo contratual do módulo: controlar **recebimento, organização, impressão, preparação e liberação** dos pedidos — sem reconstruir PDV/estoque/fiscal.

### 1.4 Requisitos adiados / fora de escopo (repetidos nos briefs)

**DOCUMENTADO** — excluídos explicitamente em S01–S05 (lista consolidada):

- Impressão térmica / fila operacional de impressão / estações
- KDS / painel de TV / UI da cozinha
- Notificações para garçons / SSE / WebSocket / push / som
- Aplicativo Android / PWA
- Retirada da rodada pelo garçom / entrega ao cliente na mesa
- Endpoints de `AUTORIZAR_QTY` e `REDUZIR_TETO` (persistência/tipos previstos; serviços não)
- Alterações em PDV, estoque, ficha técnica, fiscal, TEF, PIX, financeiro
- Integração dual-write automática ERP `pedido_preparacoes` → despacho Cozinha (pendência pré-Cozinha)

**DOCUMENTADO (S05):** “Não iniciar a Sprint 06 sem autorização expressa do Product Owner.”  
**DOCUMENTADO:** **não existe brief publicado** definindo o objetivo da Sprint 06.

---

## 2. Estado real do projeto (código)

### 2.1 Artefatos de produção Cozinha

**CÓDIGO** — serviços em `backend/services/cozinha/`:

| Arquivo | Papel |
|---|---|
| `cozinhaSchema.js` (utils) | Schema v3 + migração v2→v3 |
| `cozinhaQuantidade.js` | Precisão em milésimos |
| `cozinhaIdempotenciaHash.js` | Hash + tipos (incl. AUTORIZAR_QTY / REDUZIR_TETO / ops de prep) |
| `CozinhaDespachoService.js` | Despacho em lote + FIFO |
| `CozinhaPreparacaoService.js` | Iniciar / pronto / bebida / consulta preparação / conclusão de rodada |
| `cozinhaClassificacaoItem.js` | PASTEL / BEBIDA / OUTRO |
| `cozinhaUnidadeOperacional.js` | Unidade autenticada nas ops |
| `cozinhaAuthUnidade.js` | Validação operador↔unidade no login |

**CÓDIGO** — rotas em `backend/rotas/cozinha.js`:

| Método | Rota | Sprint de origem |
|---|---|---|
| GET | `/api/cozinha/status` | S02 |
| POST | `/api/cozinha/despacho` | S02 |
| POST | `/api/cozinha/itens/:id/iniciar` | S03/S05 |
| POST | `/api/cozinha/itens/:id/pronto` | S03/S05 |
| POST | `/api/cozinha/itens/:id/bebida/entregar` | S03/S05 |
| GET | `/api/cozinha/rodadas/:id/preparacao` | S03 |

**CÓDIGO** — auth: claim JWT `unidade_cozinha_id` validado no login (`validarUnidadeCozinhaNoLogin`) antes de `jwt.sign`.

### 2.2 Persistência prevista vs. serviços

**CÓDIGO** — tabelas/colunas existem no schema S01/S04A, mas **sem serviço operacional** correspondente:

| Estrutura | Persistência | Serviço / rota |
|---|---|---|
| `cozinha_impressao_fila` / `cozinha_estacoes_impressao` | Sim | Não |
| `cozinha_notificacoes` | Sim | Não |
| `cozinha_autorizacoes_qty` / `cozinha_reducoes_teto` | Sim | Não |
| `retirada_estado` / `entrega_estado` em rodadas | Sim (default no despacho) | Sem transição operacional |
| Outbox `cozinha_eventos_outbox` | Sim (despacho/prep) | Sem consumidor SSE/WS/KDS |

### 2.3 Sprints concluídas (evidência de testes / pacotes)

| Sprint | Evidência | Resultado registrado |
|---|---|---|
| S01 | `tests/cozinha/sprint01-*.test.js` + pacote auditoria | Fundação + correção isolamento empresa |
| S02 | `Agent/auditoria-sprint02-cozinha/` | Despacho/FIFO homologado (com correções) |
| S03 | `Agent/auditoria-sprint03-cozinha/` | Preparação/classificação/idempotência central |
| S04A | `Agent/auditoria-sprint04a-upgrade-schema/` | Migração v2→v3 + correções FK/backup |
| S05 | `Agent/auditoria-sprint05-operacoes/` | Ops itens + isolamento unidade + validação login |

**CÓDIGO / DOCUMENTADO (última execução S05):** login-auth **7/7** · S05 **23/23** · regressão S01–S04A **108/108** · `TOTAL_FAIL=0` · banco oficial não acessado.

**Nota de status:** S05 está entregue para auditoria/homologação; a aprovação definitiva permanece com o Tech Lead (não autoaprovada).

### 2.4 Funcionalidades previstas e ainda não implementadas

**DOCUMENTADO + CÓDIGO (cruzamento):**

1. Impressão de comandas (fila, reenvio, teste, isolamento da impressão comercial).
2. Estações de impressão / configuração de vias.
3. Autorizar quantidade adicional e reduzir teto (APIs).
4. Retirada pelo garçom (`ASSUMIDA_RETIRADA` → `RETIRADA`).
5. Entrega ao cliente / confirmação na mesa.
6. Notificações persistentes + entrega (SSE/LAN/Android).
7. KDS / painel / TV.
8. UI de despacho e UI de cozinha.
9. Consumidor do outbox (além da persistência).
10. Gancho ERP `PedidoPreparacaoService` → despacho Cozinha (ainda registro local no ERP).
11. Endpoints/admin de cadastro fino `cozinha_operador_unidades` (tabela auxiliar criada no path de auth; sem UI/CRUD de gestão).

---

## 3. Respostas objetivas

### 1) Qual era a sequência original de desenvolvimento?

**DOCUMENTADO:** Mesas pré-Cozinha → S01 fundação → S02 despacho/FIFO → S03 motor de preparação → S04A upgrade schema → S05 operações dos itens / isolamento.  
Arquitetura-alvo (contrato): atendimento existente → despacho → cozinha (incl. impressão) → comunicação (retirada/notificação/KDS futuro).

### 2) O que já foi concluído?

**CÓDIGO + DOCUMENTADO:** persistência v3; despacho idempotente com FIFO; classificação PASTEL/BEBIDA/OUTRO; preparação/conclusão de item e rodada; entrega parcial de bebida; outbox de eventos; isolamento por empresa; isolamento operacional por unidade autenticada (JWT + validação no login). Suites S01–S05 verdes na última regressão registrada.

### 3) O que ainda está pendente?

**DOCUMENTADO + CÓDIGO:** impressão; autorizações de qty; retirada/entrega ao cliente; notificações/tempo real; KDS/UI; integração automática Mesas/ERP→Cozinha; gestão operacional de vínculos operador↔unidade; definição formal e autorização da Sprint 06.

### 4) Qual deveria ser o objetivo da Sprint 06?

**RECOMENDAÇÃO (fundamentada no planejamento original, sem brief S06):**

Não há brief oficial de S06. Pelo contrato V1.0 e pelos adiamentos repetidos, os candidatos legítimos (em ordem de coerência com o fluxo operacional) são:

| Prioridade sugerida | Objetivo candidato | Por quê |
|---|---|---|
| **A (preferencial técnica)** | **Impressão de cozinha** — fila persistente, estações, reenvio, sem misturar impressão comercial/fiscal | Nível 3 do contrato; tabelas já na fundação S01; S02/S03/S05 adiavam explicitamente; fecha o “organizar → imprimir” antes da comunicação |
| **B** | **Retirada / assunção pelo garçom** (+ eventual notificação mínima) | Nível 4; campos `retirada_estado` já no schema; S03/S05 separaram “item PRONTO ≠ retirada” |
| **C** | **Autorizar qty / reduzir teto** | Formalizado em V1.2.3; tipos de idempotência já no schema; S02 deixou APIs de fora |

**RECOMENDAÇÃO:** tratar **S06 = Impressão de cozinha (candidato A)**, **somente após** (i) aprovação final da homologação S05 pelo Tech Lead e (ii) brief explícito do Product Owner. Não iniciar sem autorização.

### 5) Quais dependências precisam estar resolvidas antes dela?

**RECOMENDAÇÃO / DOCUMENTADO:**

1. Aprovação formal da homologação S05 (isolamento + login↔unidade) pelo Tech Lead.
2. Brief escrito da S06 com escopo fechado (impressão **ou** retirada **ou** autorizações — não misturar tudo).
3. Decisão do PO sobre prioridade A/B/C acima.
4. Se S06 = impressão: definir equipamento/estação, vias, modelo 58/80, comportamento em falha (já esboçado no contrato — falha de impressora não cancela pedido).
5. Se S06 = retirada: decidir se notificação entra na mesma sprint ou fica para S07.
6. Preservar decisões homologadas: idempotência central, milésimos, isolamento empresa/unidade, classificação S03, schema v3.

### 6) Existe decisão funcional que ainda depende de validação operacional?

**Sim — DOCUMENTADO / RECOMENDAÇÃO:**

| Decisão | Status | Quem |
|---|---|---|
| Objetivo oficial da Sprint 06 (A/B/C ou outro) | Sem brief | **Product Owner** + Tech Lead |
| Momento de ligar ERP “enviar preparação” → despacho Cozinha | Pendente desde auditoria Mesas | **PO** + Tech Lead |
| Quando implementar autorizar qty / reduzir teto | Previsto em V1.2.3; sem sprint | **PO** |
| Retirada vs. entrega ao cliente (estados e responsáveis) | Contrato define conceitos; sem sprint | **PO** operacional |
| Escopo de notificação (persistência só vs. SSE/LAN/Android) | Adiado várias vezes | **PO** |
| Gestão de `cozinha_operador_unidades` (cadastro/UI) | Tabela auxiliar existe; sem gestão | **PO** / operação |
| Homologação visual Mesas (harnesses MESAS-02/03/04) | Pendência pré-Cozinha não bloqueante | Fora do módulo Cozinha, mas impacta integração |

---

## 4. Síntese final

| Camada | Planejado (DOCUMENTADO) | Estado (CÓDIGO) |
|---|---|---|
| Atendimento / Pedido / Mesas | Reutilizar | Existente (fora do escopo Cozinha) |
| Despacho + FIFO | S02 | Implementado |
| Preparação / item pronto / bebida / rodada | S03 + S05 | Implementado |
| Isolamento unidade + auth login | Homologação S05 | Implementado |
| Impressão | Contrato Nível 3; adiado | Schema só |
| Retirada / notificação / KDS | Contrato Nível 4; adiado | Schema / campos só |
| Autorizações de qty | V1.2.3; adiado | Schema + hash; sem API |

**Próximo passo correto (RECOMENDAÇÃO):**  
1) Tech Lead avalia/aprova a homologação S05.  
2) Product Owner escolhe e publica o brief da Sprint 06 (candidato preferencial: **impressão de cozinha**).  
3) Só então autorizar implementação.

---

## 5. Condição de encerramento desta conferência

**CONFERÊNCIA DE ROADMAP ENTREGUE — AGUARDANDO AVALIAÇÃO DO TECH LEAD.**

Nenhuma implementação autorizada nesta etapa.  
Sprint 06 **não** iniciada.  
Banco oficial intocado.
