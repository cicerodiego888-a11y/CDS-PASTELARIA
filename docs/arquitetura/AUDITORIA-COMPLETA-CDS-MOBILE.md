# AUDITORIA COMPLETA — CDS MOBILE

**Tipo:** Auditoria técnica e funcional — somente leitura  
**Produto:** CDS Sistemas — Pastelaria  
**Data:** 2026-11-09  
**Escopo:** Mapear a implementação Mobile existente, classificar funcionalidades e avaliar adaptação à SmartPOS Android Positivo L400 (ambiente RedeCard / Android 11 Go).  
**Restrições respeitadas:** nenhum código, banco, rota, serviço, regra comercial/fiscal ou configuração foi alterado; nenhuma venda, pagamento TEF, NFC-e ou comunicação com a SEFAZ foi executada.

**Legenda de classificação**

| Código | Significado |
|--------|-------------|
| **CONCLUÍDA** | Implementada e comprovada por código e/ou testes isolados |
| **PARCIAL** | Implementada com limitações relevantes |
| **SIMULADA** | Demonstrada por mock/simulador (não é recebimento real) |
| **PENDENTE** | Prevista ou documentada, sem implementação operacional |
| **NÃO ENCONTRADA** | Não localizada no código |
| **NÃO VALIDADA** | Existe implementação, sem evidência suficiente de funcionamento em produção/aparelho |

---

## 1. Resumo executivo

O CDS Mobile atual é uma **casca web responsiva** servida pelo mesmo backend Express do ERP/PDV (`GET /mobile`, `/mobile-pedido`, `/mobile-mesas`, `/mobile-pdv`). Não é app nativo Android, não é PWA instalável (sem `manifest` e sem service worker) e não possui SDK Destaxa nem integração Positivo L400.

**Pedidos** e **Mesas** reutilizam contratos oficiais de API e, no caso das mesas, os mesmos controladores do painel desktop. O **PDV Mobile conclui venda pelo motor oficial** (`POST /api/vendas` via `PdvFechamentoOficial`), não apenas prepara pedido. Porém, no celular comum (sem `window.electronAPI`), **PIX/débito/crédito não são autorizados no aparelho**: o mobile só acompanha cobrança confirmada na estação com pinpad (`GET /api/tef/acompanhamento`). Dinheiro e misto com eletrônico já aprovado na estação fecham a venda.

**Para a L400:** o código atual pode, em tese, abrir por navegador HTTPS se o servidor estiver acessível; atalho nativo tipo PWA **não** está configurado; pagamento no terminal depende de integração ainda inexistente (Rede/Destaxa/fabricante). Homologação física do L400 **não foi realizada** nesta auditoria.

**Evidência de testes desta sprint (isolados, banco temporário):**  
`tests/mobile-pedido` + `tests/mobile-mesas` + `tests/mobile-pdv` → **110 testes, 110 aprovados, 0 falhas** (`node --test --test-concurrency=1`, `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `DB_DIR` temporário).

---

## 2. Arquitetura real do Mobile

### 2.1 Modelo

| Aspecto | Situação real |
|---------|----------------|
| Tipo | SPA multi-página HTML + JS vanilla (IIFE), sem React/Vue |
| Hospedagem | Estático em `frontend/` via `express.static` + rotas explícitas em `backend/server.js` |
| Entrada | `/mobile/` (hub) → Pedido / Mesas / PDV |
| Auth | JWT em `localStorage.token`; página HTML **não** protegida por `verificarToken`; APIs sim |
| Empresa | `CdsEmpresaContexto` + header `X-Empresa-Id` |
| Estado de aba | `sessionStorage` via `CdsMobileOperacao` (`cdsMobilePedido`, `cdsMobilePdv`) |
| Offline | Sem fila offline; Mesas exibe banner e reconsulta; Pedido/PDV falham com mensagem |
| PWA | **Ausente** |
| App nativo / Capacitor / Cordova | **Ausente** |

### 2.2 Fluxo macro

```text
/login?next=/mobile/
        │
        ▼
   /mobile/  (licença + empresa padrão + módulos)
   ├── /mobile-pedido/  → POST /api/pedidos → (fora mesa) preparar-venda-pdv → /mobile-pdv/
   ├── /mobile-mesas/   → painel ERP compartilhado → lançamento via /mobile-pedido/?mesa=
   │                    → conferência → preparacao/enviar
   │                    → finalizarNoPdv → /mobile-pdv/
   └── /mobile-pdv/     → parcelas → POST /api/vendas → (opcional) finalizar-venda-pdv
```

### 2.3 Tecnologias e bibliotecas usadas pelo Mobile

- HTML5, CSS próprio (`mobile-pedido.css` compartilhado), JS ES5-style IIFE
- `fetch` + JWT Bearer
- Motores PDV/ERP reutilizados: `PdvFechamentoOficial`, `PagamentoSequencial`, `InteracaoPagamentoMisto`, `TefFluxoPagamento`, `PdvPrecoComercial`, `PdvVendaPorValor`, `mesas-painel.js`, `mesas-conferencia.js`, trechos de `pedidos.js`
- Backend Node/Express + SQLite (mesmo núcleo do CDS)

---

## 3. Mapa de arquivos e diretórios

### 3.1 Frontend Mobile (casca)

```text
frontend/mobile/
  index.html                 # Hub Operação
  mobile-inicio.js           # Sessão, licença, links dos módulos

frontend/mobile-pedido/
  index.html
  mobile-pedido.js           # Gravação oficial POST /api/pedidos + handoff PDV
  mobile-pedido.css          # Layout touch base (reusado)

frontend/mobile-mesas/
  index.html
  mobile-mesas.js            # Painel + conferência + finalizarNoPdv
  mobile-mesas.css

frontend/mobile-pdv/
  index.html
  mobile-pdv.js              # Fechamento oficial POST /api/vendas
  mobile-pdv.css
```

### 3.2 Compartilhados relevantes

```text
frontend/shared/js/cds-mobile-operacao.js   # Rascunho pedido/PDV na aba
frontend/shared/js/cds-empresa-contexto.js  # Empresa + X-Empresa-Id
frontend/shared/js/tefFluxoPagamento.js
frontend/shared/js/pdv-acesso-oficial.js    # next= seguro no login
frontend/shared/login.html + login.js

frontend/pdv/js/pdv-fechamento-oficial.js
frontend/pdv/js/pagamentoSequencial.js
frontend/pdv/js/interacaoPagamentoMisto.js
frontend/pdv/js/pdv-preco-comercial.js
frontend/pdv/js/pdv-venda-por-valor.js

frontend/erp/js/pedidos.js                  # Preço/personalização no pedido mobile
frontend/erp/js/mesas-painel.js
frontend/erp/js/mesas-conferencia.js
frontend/erp/js/mesas-lancamento.js         # Carregado; lançamento real redireciona ao pedido
```

### 3.3 Backend — rotas de página e APIs usadas

| Recurso | Arquivo / rota |
|---------|----------------|
| Páginas | `backend/server.js` → `/mobile`, `/mobile-pedido`, `/mobile-mesas`, `/mobile-pdv` |
| Auth | `/api/auth` (`backend/rotas/auth.js`) |
| Pedidos | `backend/rotas/pedidos.js` |
| Mesas | `backend/rotas/mesas.js` |
| Vendas | `backend/rotas/vendas.js` |
| TEF | rotas TEF + `TefManager` / `tefFactory` |
| Smart POS simulador | `backend/services/tef/adapters/SmartPosSimuladorAdapter.js` |
| Rede (adapter) | `backend/services/tef/adapters/redeAdapter.js` → **wrapper de `SimulatedGatewayAdapter`** |

### 3.4 Testes e documentação prévia

```text
tests/mobile-pedido/mobile-pedido-02.test.js
tests/mobile-mesas/mobile-mesas-06.test.js
tests/mobile-mesas/mobile-mesas-07.test.js
tests/mobile-pdv/pdv-mobile-02.test.js … pdv-mobile-08.test.js
tests/tef/smart-pos-01.test.js
tests/tef/smart-pos-02.test.js

docs/arquitetura/MOBILE-PEDIDO-01-AUDITORIA-ESTADO-ATUAL.md   # histórico; casca já existe
docs/arquitetura/MOBILE-PEDIDO-02-IMPLEMENTACAO.md
docs/arquitetura/MESAS-06-ACESSO-MOBILE.md
docs/arquitetura/MESAS-07-PARIDADE-MOBILE-FINALIZACAO-PDV.md
docs/arquitetura/PDV-MOBILE-01 … 08
docs/arquitetura/SMART-POS-01-CONTRATO-E-SIMULADOR.md
docs/arquitetura/SMART-POS-02-INTEGRACAO-NUCLEO-TEF.md
```

---

## 4. Inventário de funcionalidades

| Módulo | Capacidade principal | Classificação |
|--------|----------------------|---------------|
| Hub `/mobile/` | Entrada, sessão, licença, empresa padrão | **CONCLUÍDA** (código+testes) |
| Pedido | Montagem e gravação EQUIPE | **CONCLUÍDA** |
| Pedido → PDV | `preparar-venda-pdv` + handoff | **CONCLUÍDA** |
| Mesas | Situação, abertura, transferência, preparação | **CONCLUÍDA** |
| Mesas → PDV individual | `finalizarNoPdv` | **CONCLUÍDA** |
| Mesas consolidada | Vários pedidos em uma venda | **NÃO ENCONTRADA** no mobile (texto aponta desktop) |
| PDV fechamento oficial | `POST /api/vendas` | **CONCLUÍDA** |
| PDV dinheiro | Parcela manual + composição | **CONCLUÍDA** |
| PDV PIX/débito/crédito no celular | Autorização no aparelho | **PARCIAL** (só via estação) |
| TEF na estação Electron | `POST /tef/pagar` com `electronAPI` | **PARCIAL** / **NÃO VALIDADA** no mobile físico |
| Smart POS L400 real | SDK / Destaxa / Positivo | **NÃO ENCONTRADA** |
| Smart POS simulador | Testes isolados | **SIMULADA** |
| Destaxa | Qualquer menção | **NÃO ENCONTRADA** |
| PWA / manifest / SW | Instalação atalho oficial | **NÃO ENCONTRADA** |
| NFC-e / SEFAZ no mobile | Emissão | **PENDENTE** (botão disabled; `emitir_fiscal: false`) |
| Offline completo | Fila de vendas/pedidos | **NÃO ENCONTRADA** |
| Homologação L400 | Aparelho real | **NÃO VALIDADA** |

---

## 5. Auditoria de Pedidos

**Arquivos:** `frontend/mobile-pedido/*`, `CdsMobileOperacao`, `frontend/erp/js/pedidos.js`, `POST /api/pedidos`.

| Funcionalidade | Status | Evidência |
|----------------|--------|-----------|
| Consulta de produtos | **CONCLUÍDA** | `buscarProdutos` → `GET /api/produtos/consulta-pdv/buscar` |
| Pesquisa e seleção | **CONCLUÍDA** | Debounce UI; erros mapeados |
| Variações / complementos | **CONCLUÍDA** | Ficha técnica + personalização ERP |
| Quantidades | **CONCLUÍDA** | Stepper / input `inputmode=numeric` |
| Observações | **PARCIAL** | Só observação do pedido; sem obs. por item |
| Carrinho | **CONCLUÍDA** | Incluir/alterar/remover/merge |
| Cálculo de valores | **CONCLUÍDA** | `calcularTotais`; servidor valida |
| Regras comerciais | **CONCLUÍDA** | `preco_pedido` → promo → `preco_venda` |
| Gravação | **CONCLUÍDA** | `POST /api/pedidos` + `Idempotency-Key`; canal **EQUIPE** no servidor |
| Recuperação | **PARCIAL** | Rascunho `sessionStorage`; sem reabrir pedido já gravado |
| Edição / correção pós-gravação | **PARCIAL** | Só pré-gravação; sem `PUT` no mobile |
| Envio para preparação | **PARCIAL** | Fora mesa: não envia; com mesa: segue para Mesas |
| Acompanhamento de status | **PARCIAL** | Confirmação local; sem painel de status no pedido |
| Associação com mesas | **CONCLUÍDA** | `?mesa=`, `GET .../atendimento`, `mesa_id` no POST |
| Tratamento de erros | **CONCLUÍDA** | Mapa de mensagens; carrinho preservado |
| Integração APIs oficiais | **CONCLUÍDA** | Contratos documentados em MOBILE-PEDIDO-02 |
| Encaminhamento ao PDV | **CONCLUÍDA** | `encaminharPedidoAoPdv` → `POST .../preparar-venda-pdv` |

**Conclusão Pedidos:** pronto para operação de lançamento em equipe/mesa. Não substitui edição avançada nem acompanhamento completo do ERP.

---

## 6. Auditoria de PDV

**Arquivos:** `frontend/mobile-pdv/*`, `pdv-fechamento-oficial.js`, `pagamentoSequencial.js`, `tefFluxoPagamento.js`.

### 6.1 Fluxo de abertura

| Etapa | Status | Evidência |
|-------|--------|-----------|
| Identificação empresa | **CONCLUÍDA** | `CdsEmpresaContexto.adotarEmpresaPadrao` / `pdv-modelo-empresa` |
| Identificação operador | **CONCLUÍDA** | `localStorage.user` + vínculo TEF/empresa nos testes 05 |
| Abertura de caixa na tela mobile | **NÃO ENCONTRADA** | Caixa aberto é pré-requisito do `POST /api/vendas` no backend |
| Consulta produtos / avulso | **CONCLUÍDA** | Busca PDV + `identificar` + cotação comercial |
| Venda pelo Valor | **CONCLUÍDA** | `prepararVendaPorValor` → contrato oficial pasteis |
| Montagem carrinho | **CONCLUÍDA** | Itens + desconto + handoff |
| Descontos / preços | **CONCLUÍDA** | Motor comercial/atacado/promo |
| Formas UI | **CONCLUÍDA** | PIX, Débito, Crédito, Dinheiro em `index.html` |
| Dinheiro | **CONCLUÍDA** | Confirmação manual + composição sequencial |
| PIX / débito / crédito | **PARCIAL** | Sem `electronAPI` → `TEF_ESTACAO`; consulta `GET /tef/acompanhamento` |
| Comunicação backend | **CONCLUÍDA** | Headers JWT + empresa |
| Finalização venda | **CONCLUÍDA** | `fechar()` → `pre-calcular-distribuicao` → `POST /api/vendas` |
| Persistência | **CONCLUÍDA** | Servidor + `vendaPersistida` na aba |
| Aprovação / recusa | **CONCLUÍDA** (contrato) | `PagamentoSequencial.classificarRetornoAutorizador` |
| Recuperação falha | **PARCIAL** | Chave de fechamento preservada; mensagem de rede; sem fila offline |
| Idempotência | **CONCLUÍDA** | `chave_fechamento_pdv` + bloqueio segunda venda na UI |
| Pagamentos pendentes | **CONCLUÍDA** | Não entram na soma; bloqueiam fechamento |
| Motor oficial | **CONCLUÍDA** | Mesmo `PdvFechamentoOficial.montarCorpo` do desktop |
| NFC-e | **PENDENTE** | `emitir_fiscal: false`; `#mv-emitir` disabled |

### 6.2 Ponto crítico — a venda é realmente concluída?

**Sim.** Evidência direta em `frontend/mobile-pdv/mobile-pdv.js`:

1. `fechar()` chama `PdvFechamentoOficial.montarCorpo(...)`.
2. Envia `POST {api}/vendas` com o corpo oficial.
3. Com handoff de pedido, chama `POST /api/pedidos/:id/finalizar-venda-pdv`.
4. Se `vendaPersistida.id` já existe, **recusa segunda venda**.

`preparar-venda-pdv` apenas monta snapshot; a venda nasce no `POST /api/vendas`.

**Limitação operacional:** botão “Finalizar venda” **não** prova pagamento eletrônico no celular. Sem confirmação da estação (ou só dinheiro), `fechar()` é bloqueado por saldo/autorização pendente.

### 6.3 Dependências de celular

| Recurso | Dependência atual |
|---------|-------------------|
| Câmera / leitor de barras | **NÃO ENCONTRADA** (código digitado) |
| Bluetooth / USB / impressora | **NÃO ENCONTRADA** no mobile |
| Pinpad | Estação Electron (`electronAPI`) |
| App externo pagamento | **NÃO ENCONTRADA** (Destaxa ausente) |

---

## 7. Auditoria de Mesas

**Arquivos:** `frontend/mobile-mesas/*` + `mesas-painel.js` + `mesas-conferencia.js`.

| Funcionalidade | Status | Mobile vs desktop |
|----------------|--------|-------------------|
| Consulta mesas | **CONCLUÍDA** | Mesmo `GET /api/mesas/situacao` |
| Livres / ocupadas | **CONCLUÍDA** | Filtros e cartões |
| Abertura atendimento | **CONCLUÍDA** | `POST .../atendimento` + idempotência |
| Recuperação atendimento | **CONCLUÍDA** | Polling + URL + `visibilitychange` |
| Lançamento pedidos | **CONCLUÍDA** | Redirect `/mobile-pedido/?mesa=` |
| Consulta pedidos vinculados | **CONCLUÍDA** | Detalhe + conferência |
| Envio preparação | **CONCLUÍDA** | `POST /api/pedidos/:id/preparacao/enviar` |
| Acompanhamento | **CONCLUÍDA** | Estados e classificação de atraso |
| Transferência | **CONCLUÍDA** | `POST .../transferir` |
| Fechamento de conta / encerrar mesa | **PENDENTE** no mobile | Estado FECHAMENTO só leitura; encerramento via fluxo pago/backend |
| Integração venda oficial (pedido a pedido) | **CONCLUÍDA** | `finalizarNoPdv` |
| Venda consolidada da mesa | **NÃO ENCONTRADA** no mobile | Explicitamente “apenas no computador” |
| Sync painel desktop | **CONCLUÍDA** | Mesmos controladores/APIs |
| Concorrência / duplicidade | **CONCLUÍDA** | `geracao`/`seq`, idempotência, anti-duplo toque PDV |
| Offline | **PARCIAL** | Banner + reconsulta; sem mutações offline |

---

## 8. Integrações com backend

| Capacidade | Endpoint(s) principais | Origem |
|------------|------------------------|--------|
| Login | `/api/auth` | shared login |
| Empresas / padrão | `/api/empresas/contexto/padrao` (via contexto) | shared |
| Clientes | `GET /api/clientes/buscar` | pedido |
| Produtos | consulta-pdv, identificar, ficha, promo, atacado | pedido/PDV |
| Pedidos | `POST /api/pedidos`, `preparar-venda-pdv`, `finalizar-venda-pdv`, `preparacao/enviar` | pedido/mesas/PDV |
| Mesas | situação, atendimento, pedidos, transferir | mesas |
| Vendas | `composicao-sequencial`, `pre-calcular-distribuicao`, `POST /api/vendas` | PDV |
| TEF | `POST /api/tef/pagar`, `GET /api/tef/acompanhamento` | PDV |
| Fiscal | `POST /api/fiscal/emitir/venda/:id` | presente mas bloqueado na UI |

Isolamento: APIs autenticadas; `X-Empresa-Id` obrigatório no fluxo mobile; servidor define canal EQUIPE e autoridade de operador/empresa (cliente não envia como fonte de verdade — coberto em `mobile-mesas-06`).

---

## 9. Integração de pagamentos e TEF

### 9.1 O que já existe

1. Núcleo TEF: `TefManager`, `tefFactory`, adaptadores SiTef / PayGo / Stone / Cielo / Rede / Getnet.
2. Mobile PDV: pagamento sequencial + composição F×NF + fechamento oficial.
3. Modelo operacional atual no celular: **estação com pinpad inicia** (`POST /tef/pagar` no Electron); **celular consulta** (`GET /tef/acompanhamento`).
4. Contrato Smart POS independente + `SmartPosSimuladorAdapter` (somente teste).
5. Proteção: simulação **não** conta como recebimento (`OrquestradorPagamento` / `SIMULACAO_NAO_E_RECEBIMENTO`).

### 9.2 O que está simulado

| Item | Evidência |
|------|-----------|
| `smart_pos_simulador` | Adapter + SMART-POS-01/02; fábrica só com sinais de teste |
| `RedeAdapter` | Instancia `SimulatedGatewayAdapter` com nome `Rede` — **não** é SDK RedeCard L400 |
| Textos UI | “Smart POS simulada não é recebimento real” em `mobile-pdv/index.html` |

### 9.3 O que está pendente

- Autorização TEF **no próprio terminal** L400
- Emissão fiscal no mobile
- Offline de pagamento
- Homologação adquirente no aparelho

### 9.4 Separação de dependências externas

| Dependência | Situação |
|-------------|----------|
| **Rede (adquirente / RedeCard)** | Adapter nominal existe, mas é simulador; contrato real L400 **não** no repositório |
| **Destaxa** | **NÃO ENCONTRADA** (zero ocorrências no código) |
| **Fabricante Positivo / L400** | Modelo, SDK, protocolo, terminal id **ausentes** |
| **Estação CDS (Electron)** | Caminho atual suportado para pinpad |

### 9.5 Como a integração de pagamentos deve acontecer (recomendação arquitetural, sem implementar)

1. Manter o núcleo atual (`TefManager` + `PagamentoSequencial` + `POST /api/vendas`).
2. Criar **adaptador real** no `tefFactory` (não reutilizar o simulador como produção).
3. Decidir canal no L400:
   - **A)** App/WebView no L400 chama o adaptador local (ideal para SmartPOS), ou  
   - **B)** Continuar “cobrança no terminal + correlacao no browser” (já existe, mas exige dois pontos operacionais).
4. Mapear retornos do protocolo Rede/Destaxa/Positivo para estados CDS (`aprovado`, `negado`, `pendente`, `timeout`, `erro`).
5. Garantir idempotência, isolamento empresa/operador e **proibição** de gravar simulação como recebimento.
6. Só então liberar PIX/débito/crédito no fluxo mobile sem depender da estação Windows.

---

## 10. Segurança e integridade

| Tema | Avaliação | Evidência |
|------|-----------|-----------|
| Autenticação | **CONCLUÍDA** nas APIs; páginas HTML abertas sem token server-side | `localStorage.token`; redirect cliente |
| Autorização / licença | **PARCIAL** | Hub consulta licença; `/mobile-pdv` depende das APIs |
| Isolamento por empresa | **CONCLUÍDA** | `X-Empresa-Id` + divergências TEF testadas |
| Validação backend | **CONCLUÍDA** | Totais, caixa, composição, TEF |
| Persistência local | **PARCIAL** | `sessionStorage` por aba; perde ao fechar |
| Idempotência pedidos/vendas/TEF | **CONCLUÍDA** | Chaves + testes |
| Duplicidade | **CONCLUÍDA** (contratos) | Anti-duplo clique, `TRANSACAO_JA_VINCULADA`, `vendaPersistida` |
| Proteção de dados sensíveis TEF | **PARCIAL** | Acompanhamento público omite NSU/autorização |
| Sessão após reload | **PARCIAL** | Token em `localStorage`; rascunho em `sessionStorage` |
| Sem internet | **PARCIAL** | Mensagens; Mesas reconsulta; sem fila |
| Concorrência celular × desktop | **CONCLUÍDA** (mesas) / **NÃO VALIDADA** em carga real | Controles de geração/seq |
| Token em localStorage | Risco XSS clássico de SPA | Comportamento atual do CDS login |

Nenhum mecanismo foi modificado nesta sprint.

---

## 11. Testes e evidências

### 11.1 Suítes Mobile executadas nesta auditoria

Comando (sequencial, banco temporário, sem abrir banco oficial):

```text
node --test --test-concurrency=1
  tests/mobile-pedido/mobile-pedido-02.test.js
  tests/mobile-mesas/mobile-mesas-06.test.js
  tests/mobile-mesas/mobile-mesas-07.test.js
  tests/mobile-pdv/pdv-mobile-02.test.js
  … pdv-mobile-08.test.js
```

**Resultado:** `tests 110` · `pass 110` · `fail 0` · `duration_ms ~50616`.

### 11.2 Cobertura por módulo

| Módulo | Arquivos | Foco | Resultado |
|--------|----------|------|-----------|
| Pedido | `mobile-pedido-02` | Página, sessão, preço, carrinho, gravação EQUIPE | OK |
| Mesas | `06`, `07` | Acesso, rede, PDV individual, consolidada ausente | OK |
| PDV | `02`–`08` | Handoff, TEF estação, operador, empresa, equivalência | OK |

### 11.3 Limitações dos testes

- Usam harness / fetch simulado / banco temporário — **não** homologam celular físico nem L400.
- Não executam adquirente real, Destaxa, NFC-e ou SEFAZ.
- Não provam desempenho em Android 11 Go.
- Suítes TEF Smart POS (`smart-pos-01/02`) existem e documentam simulador; **não** foram reexecutadas nesta bateria para evitar expansão desnecessária (já cobertas nos relatórios SMART-POS-01/02).

**Homologação física L400:** **não declarada**.

---

## 12. Compatibilidade com SmartPOS L400

**Equipamento-alvo informado:** Positivo L400 · RedeCard · Android 11 Go.

### 12.1 Navegador e PWA

| Pergunta | Resposta baseada no código |
|----------|----------------------------|
| Pode abrir por HTTPS? | **Sim, se** o backend CDS estiver exposto em HTTPS alcançável pelo aparelho. O código usa URLs relativas/`API_URL`; não há lock a `localhost` no mobile. Disponibilidade de HTTPS é de **infra**, não de feature Mobile. |
| Dependência de navegador específico? | **NÃO ENCONTRADA** (HTML/JS padrão). Em Android 11 Go, o navegador padrão pode ser limitado — **NÃO VALIDADA**. |
| Instalação PWA? | **NÃO ENCONTRADA** |
| Manifest? | **NÃO ENCONTRADO** |
| Service workers? | **NÃO ENCONTRADOS** |
| Atalho na tela inicial? | Só pelo recurso manual do Chrome/WebView (“Adicionar à tela inicial”), **sem** `display: standalone` configurado pelo CDS |
| Modo standalone? | **NÃO ENCONTRADO** |
| Login/sessão nesse modelo? | Deve funcionar como SPA (token em `localStorage`), **NÃO VALIDADA** no L400 |

### 12.2 Interface

| Tema | Avaliação |
|------|-----------|
| Responsividade | **PARCIAL** — layout `max-width: 720px`, touch `48px`, viewport-fit; não há media queries específicas para 480–720 portrait tipicamente de POS |
| Orientação | Sem lock; presume portrait |
| Teclado virtual / `inputmode` | Presente em campos numéricos |
| Modais | `<dialog>` no PDV — suporte depende do WebView/Chrome do L400 (**NÃO VALIDADA**) |
| Desempenho / memória Go | **NÃO VALIDADA** (Mesas carrega vários JS ERP) |
| Android 11 Go | Sem prova no repositório |

### 12.3 Recursos de hardware

A implementação **não** depende de câmera, Bluetooth, USB, impressora ou leitor nativo. Depende de **rede HTTP(S)** e, para cartão/PIX no modelo atual, de **estação TEF externa**. No L400, o hardware de pagamento **não está ligado** ao CDS.

---

## 13. Funcionalidades que podem ser reaproveitadas sem alterações

1. Hub `/mobile/` (sessão, licença, navegação).
2. Mobile Pedido (gravação EQUIPE + personalização + mesa).
3. Mobile Mesas (painel, preparação, transferência, handoff individual).
4. Motor de fechamento `PdvFechamentoOficial` + pagamento sequencial.
5. Contratos de idempotência, empresa e operador.
6. Handoff `preparar-venda-pdv` / `finalizar-venda-pdv`.
7. Consulta de cobrança na estação (`/tef/acompanhamento`) como modo intermediário.
8. Suítes de teste Mobile já existentes.

---

## 14. Funcionalidades que precisam de adaptação

1. Autorização eletrônica **no terminal** (hoje `TEF_ESTACAO` sem `electronAPI`).
2. UI/CSS para tela pequena de POS (densidade, teclado, `<dialog>`).
3. Exposição HTTPS estável na rede da loja (infra + certificado).
4. Política de sessão em WebView/kiosk (se L400 operar embutido).
5. Mensagens operacionais (correlacao estação vs pagamento local).
6. Possível redução de bundles JS no Mesas para Android Go.
7. Atalho/PWA se o Product Owner exigir ícone dedicado.

---

## 15. Funcionalidades que precisam ser desenvolvidas

1. Adaptador TEF real L400/Rede/Destaxa registrado em `tefFactory`.
2. Bridge nativa ou WebView credenciada (se o fabricante exigir app).
3. Fluxo de cancelamento/timeout/recuperação ambígua específico do terminal.
4. (Opcional) PWA: `manifest.webmanifest` + service worker mínimo + ícones.
5. Venda consolidada de mesa no mobile (hoje só desktop).
6. Encerramento/fechamento avançado de mesa no mobile.
7. Emissão fiscal no mobile, se exigida na operação portátil.
8. Edição pós-gravação de pedido / observação por item, se exigidas.
9. Fila offline — apenas se operação sem rede for requisito.

---

## 16. Bloqueios externos e dependências

| Bloqueio | Dependência |
|----------|-------------|
| Credenciais / homologação adquirente | **Rede / RedeCard** |
| Middleware ou SDK de pagamento SmartPOS | **Destaxa** (se for o provedor escolhido; hoje inexistente no repo) |
| Documentação SDK, modelo, protocolo, terminal id | **Positivo / fabricante L400** |
| Pinpad atual do CDS | Estação Windows + Electron |
| Caixa aberto + licença ativa | Operação CDS já existente |
| Certificado HTTPS / DNS / firewall da loja | Infra do cliente |

Enquanto esses itens externos não existirem, **não há caminho no código** para o L400 autorizar PIX/cartão como recebimento real.

---

## 17. Riscos técnicos

1. Confundir tela de pagamento com venda eletrônica concluída no celular.
2. Tratar `RedeAdapter` atual como integração RedeCard real (é simulador).
3. Aceitar `smart_pos_simulador` como produção (núcleo já bloqueia — manter bloqueio).
4. Android 11 Go: memória/CPU com Mesas + vários scripts ERP.
5. Token JWT em `localStorage` em navegador compartilhado do POS.
6. Sem PWA: usuário perde atalho/sessão com limpeza de dados do Chrome.
7. Operação mista celular + desktop sem disciplina de correlacao TEF.
8. Homologação documental antiga (MOBILE-PEDIDO-01) pode induzir estado “sem mobile” — código atual prevalece.

---

## 18. Recomendação arquitetural

**Não reinventar o PDV.** Reaproveitar a casca Mobile + motor oficial de vendas/TEF.

Caminho recomendado para L400:

1. **Curto prazo (sem SDK):** operar Pedidos/Mesas/PDV no navegador do L400 para **lançamento e fechamento em dinheiro**; cartão/PIX continuam na estação (modelo já implementado).
2. **Médio prazo:** integrar adaptador SmartPOS real no `tefFactory`, acionado no próprio L400, alimentando o mesmo `PagamentoSequencial`.
3. **Não** contornar `OrquestradorPagamento` nem gravar simulação como recebimento.
4. Tratar PWA como melhoria de UX, não como substituto do adaptador de pagamento.
5. Manter Mesas consolidada no desktop até haver sprint específica.

---

## 19. Plano sugerido de evolução em pequenas sprints

> **Esta sprint de auditoria não inicia a evolução.** Sequência sugerida para aprovação do Product Owner:

| Sprint | Objetivo | Entrega |
|--------|----------|---------|
| **A1** | Infra HTTPS + checklist L400 browser | Abrir `/mobile/` no aparelho; login; captura de limitações Go |
| **A2** | UX POS (CSS/teclado/dialog) | Pedido + PDV dinheiro usáveis na resolução do L400 |
| **A3** | Homologar dinheiro + handoff mesa/pedido | Venda oficial só dinheiro no L400 (caixa/licença reais de homologação) |
| **B1** | Contrato técnico Rede/Destaxa/Positivo | Doc de protocolo + decisão de canal (nativo vs WebView) |
| **B2** | Adaptador TEF L400 (sandbox) | `tefFactory` + testes isolados; sem produção |
| **B3** | Pagamento no terminal + fechamento oficial | PIX/débito/crédito no L400 com idempotência |
| **B4** | Recuperação ambígua / cancelamento / conciliação | Timeout, consulta, anti-duplicidade |
| **C1** | (Opcional) PWA atalho | Manifest + ícones + standalone |
| **C2** | (Opcional) Consolidada mesas no mobile | Paridade MESAS-05.3 |
| **C3** | (Opcional) Fiscal no mobile | Só após regra de negócio autorizar |

Menor caminho para **operação funcional mínima:** A1 → A2 → A3 (lançamento + venda dinheiro).  
Menor caminho para **SmartPOS com cartão/PIX no L400:** A1–A3 + B1–B3.

---

## 20. Conclusões objetivas (Product Owner)

| Pergunta | Resposta |
|----------|----------|
| O CDS Mobile já pode funcionar como PDV portátil? | **Parcialmente.** Como lançador + fechamento oficial, **sim para dinheiro** (e eletrônico já confirmado na estação). Como SmartPOS autônomo com cartão/PIX no aparelho, **não**. |
| O que já está pronto? | Hub, Pedido EQUIPE, Mesas (exceto consolidada/fechamento avançado), PDV com motor oficial, idempotência, testes Mobile (110/110). |
| O que falta para a L400? | Prova HTTPS/browser no aparelho; UX POS; adaptador de pagamento real; credenciais Rede/Destaxa/fabricante; homologação física. |
| Podemos usar a implementação atual pelo navegador? | **Sim**, como web app do CDS, se o servidor estiver acessível. |
| Podemos adicionar atalho na tela inicial? | Manualmente pelo navegador, **sem** PWA oficial. PWA dedicada = desenvolvimento novo. |
| O PDV Mobile conclui vendas pelo motor oficial? | **Sim** — `POST /api/vendas` via `PdvFechamentoOficial`. Não é só preparação de pedido. |
| Como deve ser a integração de pagamentos? | Adaptador no núcleo TEF existente; L400 autoriza; mobile/PDV consome o mesmo contrato de parcelas; simulação continua fora do recebimento real. |
| Bloqueios Rede e Destaxa? | Rede: integração real do terminal/adquirente. Destaxa: **ausente** no código — se for o middleware, depende 100% de contrato/SDK externos. |
| Menor sequência de sprints? | A1→A2→A3 para operação dinheiro; depois B1→B3 para pagamento no L400. |

---

## 21. Controle desta auditoria

| Item | Valor |
|------|-------|
| Alterações de código | Nenhuma |
| Operações financeiras/fiscais | Nenhuma |
| Banco oficial | Não aberto (`CDS_BLOQUEAR_BANCO_OFICIAL`) |
| Homologação L400 | Não realizada |
| Relatório | `docs/arquitetura/AUDITORIA-COMPLETA-CDS-MOBILE.md` |

**Próximo passo autorizado apenas pelo Product Owner:** aprovar (ou rejeitar) o plano de sprints da seção 19. Nenhuma sprint de evolução foi iniciada.
