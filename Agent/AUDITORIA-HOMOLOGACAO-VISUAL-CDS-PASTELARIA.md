# AUDITORIA — Homologação Visual do CDS Pastelaria

**Data:** 2026-11-17  
**Responsável (diagnóstico):** Cursor  
**Direção técnica:** ChatGPT — Tech Lead  
**Autorização:** somente leitura e diagnóstico — **nenhuma implementação**  
**Sprint 06:** preservado / congelado — **não** modificado  

---

## 0. Conclusão executiva (Cozinha)

**Não existe tela operacional de Cozinha (KDS) no frontend do CDS Pastelaria.**

O usuário não encontra a “tela da Cozinha” porque ela **não foi implementada como interface**. O que existe hoje:

| Camada | Situação |
|--------|----------|
| APIs `/api/cozinha/*` (despacho, preparação, estações, fila) | Backend presente |
| Worker Electron de impressão de cozinha (Sprint 06) | Integração main/IPC — **sem tela de operador** |
| Menu ERP “Cozinha” / rota `/erp` → KDS | **Ausente** |
| Frontend que chama `/api/cozinha` ou `/impressao/estacoes` / `/impressao/fila` | **Nenhum arquivo em `frontend/`** |

O botão **“Enviar pedido para cozinha”** em Mesas/Pedidos chama `POST /api/pedidos/:id/preparacao/enviar` (ERP `PedidoPreparacaoService`). A própria UI declara que isso **não confirma** recebimento por cozinha, impressora ou KDS.

Fontes: `frontend/erp/index.html` (sidebar sem item Cozinha), `frontend/erp/js/app.js` (`loadPage` sem case `cozinha`), grep em `frontend/**` sem consumo de `/api/cozinha`, `backend/rotas/cozinha.js` (API only), `Agent/CONFERENCIA-ROADMAP-COZINHA-POS-S05.md` (KDS/UI explicitamente fora de S01–S05; S06 = impressão, não UI).

---

## 1. Pontos de entrada da aplicação

| Entrada | URL | Arquivo | Autenticação |
|---------|-----|---------|--------------|
| Login | `/login` | `frontend/shared/login.html` | Público |
| ERP (shell SPA) | `/erp` | `frontend/erp/index.html` + `frontend/erp/js/app.js` | Token JWT |
| PDV oficial | `/pdv` | `frontend/pdv/index.html` | Token JWT |
| Mobile hub | `/mobile` | `frontend/mobile/index.html` | Sessão mobile |
| Mobile Pedido | `/mobile-pedido` | `frontend/mobile-pedido/index.html` | Sessão mobile |
| Mobile Mesas | `/mobile-mesas` | `frontend/mobile-mesas/index.html` | Sessão mobile |
| Mobile PDV | `/mobile-pdv` | `frontend/mobile-pdv/index.html` | Sessão mobile |
| Mobile Contagem | `/mobile-contagem` | `frontend/mobile-contagem/index.html` | Sessão mobile |
| PDV Universal | `/pdv-universal` | **Redireciona 302 → `/pdv`** (UI congelada / não servida) | — |

Fonte: `backend/server.js` (rotas `sendFile` / redirect).

Navegação ERP: sidebar `data-page="..."` → `loadPage(page)` em `frontend/erp/js/app.js` (sem rotas hash dedicadas por módulo; conteúdo em `#page-content`).

---

## 2. Tabela-resumo (funcionalidades × tela)

| Funcionalidade | Tela existe? | Acesso pelo menu? | Estado |
|---|---|---|---|
| Login | Sim | N/A (URL) | Completa |
| Dashboard | Sim | Sim (Painel) | Completa |
| MIS | Sim | Sim (Painel) | Completa |
| Central de Monitoramento | Sim | Sim (Painel; recurso `fiscal`) | Completa |
| PDV (vendas/caixa operacional) | Sim | Sim (Comercial → PDV → `/pdv`) | Completa |
| Histórico de Vendas | Sim | Sim | Completa |
| Entregas | Sim | Sim | Completa |
| Pedidos | Sim | Sim | Completa |
| Comandas (como entidade KDS) | Não | Não | Sem UI |
| Controle de Mesas / atendimento mesa | Sim | Sim | Completa |
| Preparação ERP (“enviar para cozinha”) | Sim (ação embutida) | Via Mesas/Pedidos | Parcial (registro ERP, não KDS) |
| Cozinha (KDS) | **Não** | **Não** | **Inexistente na UI** |
| Estações de impressão (cozinha) | **Não** | **Não** | API only |
| Fila de impressão (cozinha) | **Não** | **Não** | API + Worker Electron (sem tela) |
| Teste de estação de impressão | **Não** | **Não** | API `POST .../estacoes/:id/teste` only |
| Expedição | Sim | Sim | Completa |
| Central de Faturamento / NF-e | Sim | Sim | Completa |
| Fechamento de Caixa (ERP) | Sim | Sim | Completa |
| Gerenciar Caixas | Sim | Sim (recurso `multiCaixa`) | Completa |
| Produtos | Sim | Sim | Completa |
| Insumos | Sim | Sim | Completa |
| Categorias | Sim | Sim | Completa |
| Compras | Sim | Sim | Completa |
| Central de Entradas | Sim | Sim (recurso `fiscal`) | Completa |
| Contagem Física | Sim | Sim | Completa |
| Financeiro | Sim | Sim | Completa |
| Contas Bancárias | Sim | Sim | Completa |
| Clientes | Sim | Sim | Completa |
| Fornecedores | Sim | Sim | Completa |
| NFC-e / NF-e / fila / monitor / diagnóstico | Sim | Sim (grupo Fiscal) | Completa |
| Central Contábil | Sim | Sim | Completa |
| Configurações da Empresa | Sim | Sim | Completa |
| Centro de Configurações | Sim | Sim | Completa |
| Gestão Empresas (fiscal multiempresa) | Sim | **Não** (via Centro de Config.) | Completa |
| Importação Inicial de Produtos | Sim | **Não** (via Centro de Config.) | Completa |
| Configuração TEF | Sim (modal/feature) | Via Centro de Config. | Completa |
| Impressora de cupom (comercial) | Sim (em Configurações) | Via Configurações | Completa (domínio comercial ≠ cozinha) |
| Usuários | Sim | Sim | Completa |
| Assinatura / Licença | Sim | Sim | Completa |
| Auditoria | Sim | Sim | Completa |
| Observabilidade / MIB / Search / Knowledge / CIP / Copiloto | Sim | Sim | Completa |
| Central / Lab. Equipamentos / Enviar Produtos balança | Sim | Sim | Completa |
| Relatórios (grupo) | Placeholder | Oculto (`hidden`) | Indisponível |
| Mobile Pedido / Mesas / PDV / Contagem | Sim | Via `/mobile` | Completa (escopo mobile) |
| PDV Universal (UI) | Não (redirect) | Não | Congelado |

---

## 3. Inventário detalhado — ERP (menu lateral)

Acesso base: login → `/erp`. Itens em `frontend/erp/index.html`. Loader: `frontend/erp/js/app.js`.

### 3.1 Painel

| Nome | Menu | `data-page` / URL | Componente | O que testar | Dependências |
|------|------|-------------------|------------|--------------|--------------|
| Dashboard | Painel → Dashboard | `dashboard` | `erp/pages/dashboard.html`, `erp/js/dashboard.js` | Indicadores / comandos | Sessão ERP |
| MIS | Painel → MIS | `mis` | `erp/pages/mis.html`, `erp/js/mis.js` | Painel MIS | Sessão |
| Central de Monitoramento | Painel | `monitoring` | `erp/js/cds-monitoring-engine.js` | Monitoramento | Recurso `fiscal` |

### 3.2 Comercial / atendimento

| Nome | Menu | Acesso | Componente | O que testar | Dependências |
|------|------|--------|------------|--------------|--------------|
| PDV | Comercial → PDV | `/pdv` | `frontend/pdv/*` | Venda, pagamento, caixa PDV | Recurso `pdv`, sessão |
| Histórico de Vendas | Comercial | `vendas` | `erp/js/vendas.js` | Consulta vendas | Recurso `historicoVendas` |
| Entregas | Comercial | `entregas` | `pdv/js/entregas.js` | Vendas entrega | Recurso `vendasEntrega` |
| Pedidos | Comercial → Pedidos | `pedidos` | `erp/js/pedidos.js` (+ mesas-*) | CRUD/listagem pedidos, handoff PDV, conferência | Recurso `pedidos` |
| Controle de Mesas | Comercial → Controle de Mesas | `mesas` | `erp/js/mesas-painel.js`, `mesas-lancamento.js`, `mesas-conferencia.js` | Mesas, lançamento, **enviar preparação** | Recurso `pedidos` |
| Expedição | Comercial | `faturamento` | `erp/js/faturamento.js` | Expedição | Recurso `expedicao` |
| Central de Faturamento | Comercial | `central-faturamento` | `erp/js/central-faturamento.js` | Operação NF-e | Recurso `nfe` |
| Fechamento de Caixa | Comercial | `caixa` | `erp/js/caixa.js` | Fechamento | Sessão |

**Preparação (não é KDS):** em Mesas/Pedidos, `mesas-conferencia.js` — botão “Enviar pedido para cozinha” → `POST /api/pedidos/:id/preparacao/enviar`. Texto da UI: registro operacional do ERP; **não** confirma cozinha/impressora/KDS.

### 3.3 Suprimentos / estoque / cadastros / financeiro

| Nome | Menu | `data-page` | Script principal |
|------|------|-------------|------------------|
| Produtos | Suprimentos | `produtos` | `erp/js/produtos.js` |
| Insumos | Suprimentos | `insumos` | `erp/js/produtos.js` (modo insumos) |
| Categorias | Suprimentos | `categorias` | `erp/pages/categorias.html` |
| Compras | Suprimentos | `compras` | `erp/js/compras.js` |
| Central de Entradas | Suprimentos | `central-entradas` | `erp/js/central-entradas.js` |
| Contagem Física | Estoque | `contagem-estoque` | `erp/js/contagem-estoque.js` |
| Financeiro | Financeiro | `financeiro` | `erp/pages/financeiro.html` + módulos |
| Contas Bancárias | Financeiro | `contas-bancarias` | `erp/js/contas-bancarias.js` |
| Gerenciar Caixas | Financeiro | `caixas` | `erp/pages/caixas.html` |
| Clientes | Cadastros | `clientes` | `erp/js/clientes.js` |
| Fornecedores | Cadastros | `fornecedores` | `erp/js/fornecedores.js` |

### 3.4 Fiscal

| Nome | `data-page` | Observação |
|------|-------------|------------|
| NFC-e Emitidas | `fiscal` | Recurso `nfce` |
| Nova NF-e | `nfe-avulsa` | Recurso `nfe` |
| NF-e Emitidas | `nfe-central` | |
| Monitor / Fila / Diagnóstico NF-e | `nfe-monitor`, `nfe-fila`, `nfe-diagnostico` | |
| Central Contábil | `central-contabil` | |

### 3.5 Administração / config

| Nome | Menu? | Acesso | Componente |
|------|-------|--------|------------|
| Configurações | Sim | `configuracoes` | `erp/js/configuracoes.js` (incl. **impressora_cupom** comercial) |
| Centro de Configurações | Sim | `configuracoes-avancadas` | `erp/js/cds-centro-configuracoes.js` |
| Empresas (gestão fiscal) | **Não** no sidebar | `loadPage('empresas')` a partir do Centro | `erp/js/gestao-empresas-fiscal.js` |
| Importação Inicial de Produtos | **Não** no sidebar | Botão no Centro → `importacao-inicial-produtos` | `erp/js/importacao-inicial-produtos.js` |
| Configuração TEF | Feature | Botões no Centro | `erp/js/configuracao_tef.js` / `pages/ConfiguracaoTEF.html` |
| Usuários, Assinatura, Auditoria, Observabilidade, MIB, Search, Knowledge, CIP, Copiloto | Sim | respectivos `data-page` | scripts em `erp/js/*` |
| Central Equipamentos / Lab / Enviar Produtos | Sim | `central-equipamentos`, `laboratorio-equipamentos`, `enviar-produtos-balanca` | |
| Saúde da Central / Auditoria DF-e | Sim | `central-diagnostico`, `dfe-auditoria` | recurso `fiscal` |
| Relatórios | Placeholder oculto | — | Indisponível |

`equipamentos` (`erp/js/equipamentos.js`) tem loader em `app.js`, mas **não** há item de menu `data-page="equipamentos"` no sidebar atual (entrada prática: Central de Equipamentos).

---

## 4. Mobile

Hub `/mobile` → links:

| Módulo | URL | Arquivo | Testável |
|--------|-----|---------|----------|
| Pedido | `/mobile-pedido/` | `mobile-pedido/mobile-pedido.js` | Pedido móvel / handoff |
| Mesas | `/mobile-mesas/` | `mobile-mesas/mobile-mesas.js` | Mesas + texto de preparação ERP (sem KDS) |
| PDV | `/mobile-pdv/` | `mobile-pdv/mobile-pdv.js` | PDV assistido |
| Contagem Física | `/mobile-contagem/` | `mobile-contagem/mobile-contagem.js` | Contagem (quando liberado na UI) |

**Não há** `/mobile-cozinha` nem módulo Cozinha no hub.

---

## 5. Situação real — Módulo Cozinha (perguntas obrigatórias)

| Pergunta | Resposta fundamentada |
|----------|----------------------|
| Existe tela operacional da Cozinha (KDS)? | **Não.** Nenhum HTML/JS de painel KDS em `frontend/`. |
| Existe rota frontend? | **Não** (`/erp` sem `data-page`/`case` cozinha; sem `/cozinha`). |
| Existe componente visual de acompanhamento de pedidos na cozinha? | **Não.** |
| Existe menu ou botão para KDS? | **Não.** Há apenas “Enviar pedido para cozinha” (preparação ERP). |
| Integração frontend com APIs de despacho/preparação Cozinha? | **Não** no frontend. APIs em `backend/rotas/cozinha.js` (`/despacho`, `/itens/...`, `/rodadas/:id/preparacao`). |
| Fila de impressão tem tela? | **Não.** API `GET /api/cozinha/impressao/fila`. Worker Electron (Sprint 06) sem UI de fila. |
| Tela de configuração de estações? | **Não.** API `GET/POST/PUT /api/cozinha/impressao/estacoes`. |
| Teste/visualização de estação na UI? | **Não.** API `POST /api/cozinha/impressao/estacoes/:id/teste` (retorna preview; `impressao_fisica: false` no contrato de teste). |
| Sessão Electron impressão cozinha | `login.js` / `core.js` chamam `electronAPI.cozinhaImpressao.estabelecerSessao` / `logout` — **infra**, não tela de operador. |

---

## 6. Sem interface (backend / Electron apenas)

Não confundir com telas:

- Schema/tabelas Cozinha v3  
- `CozinhaDespachoService`, `CozinhaPreparacaoService`  
- Fila/estações/renderer/worker Sprint 06  
- `electron-cozinha-impressao.js` (IPC; renderer **não** dispara print genérico)  
- Endpoints `/api/cozinha/*`  

Homologação **visual** desses itens **não é possível** pela interface atual.

---

## 7. Problemas de navegação identificados

1. **Expectativa vs realidade:** “Cozinha” no botão de Mesas ≠ tela KDS.  
2. **Sprint 06 aprovado sem UI:** impressão operacional sem painel de estações/fila.  
3. **Telas fora do menu:** `empresas`, `importacao-inicial-produtos` (Centro de Configurações).  
4. **Grupo Relatórios** oculto/placeholder.  
5. **PDV Universal** redireciona para `/pdv` — não usar como tela separada.  
6. **Visibilidade de menu** depende de `data-recurso` / perfil (`access-control.js`) — itens podem sumir sem serem “inexistentes”.

---

## 8. O que dá para homologar visualmente agora (sequência sugerida)

Sem criar telas e sem impressão física de cozinha:

1. **Login** → `/login`  
2. **ERP Dashboard** → `/erp`  
3. **Produtos / Categorias / Insumos** (cadastro base)  
4. **Controle de Mesas** → lançar pedido → **Enviar pedido para cozinha** (validar só registro ERP de preparação)  
5. **Pedidos** (lista / conferência / handoff PDV)  
6. **PDV** `/pdv` (venda e pagamentos — sem fiscal real se política local exigir)  
7. **Fechamento de Caixa** / **Gerenciar Caixas**  
8. **Configurações** (incl. impressora **cupom** comercial — domínio distinto da cozinha)  
9. **Mobile** `/mobile` → Pedido / Mesas / PDV  
10. Fiscal / Financeiro / Entradas — conforme perfil e necessidade  

**Não incluir** nesta sequência: KDS, estações de impressão de cozinha, fila de impressão de cozinha, teste visual de estação — **sem UI**.

---

## 9. Escopo desta auditoria

- Nenhuma alteração de código de produto.  
- Nenhuma rota/tela criada.  
- Nenhuma migration / banco oficial / fiscal / impressão física.  
- Sprint 06 **não** reaberto.  
- Sprint 07 **não** iniciado.  

---

## 10. Evidências (arquivos-chave)

| Evidência | Arquivo |
|-----------|---------|
| Menu ERP completo | `frontend/erp/index.html` |
| Switch de páginas | `frontend/erp/js/app.js` |
| Entradas HTTP | `backend/server.js` |
| APIs Cozinha (sem UI) | `backend/rotas/cozinha.js` |
| “Enviar para cozinha” ERP | `frontend/erp/js/mesas-conferencia.js`, `backend/rotas/pedidos.js` |
| Hook Electron sessão | `frontend/shared/js/login.js`, `frontend/shared/js/core.js` |
| Frontend sem `/api/cozinha` | grep `frontend/**` — zero matches |
| KDS fora do roadmap S01–S05 | `Agent/CONFERENCIA-ROADMAP-COZINHA-POS-S05.md` |

---

**Entrega para avaliação do Tech Lead e autorização do Product Owner.**  
**Sem implementação. Sem homologação física de cozinha.**
