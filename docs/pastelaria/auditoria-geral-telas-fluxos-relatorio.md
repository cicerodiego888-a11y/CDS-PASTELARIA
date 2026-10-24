# Auditoria geral das telas e fluxos — CDS Pastelaria

Etapa **somente de auditoria**. Nenhum código de produção, banco, schema, endpoint ou navegação foi alterado. Banco oficial não acessado. Sem commit/push/merge/reset.

Convenção de evidência: **[CÓD]** leitura de código; **[TESTE]** teste executado em banco temporário isolado; **[EXEC]** observado em execução real. **Nenhum item deste relatório é [EXEC]**: não houve abertura de navegador nem do sistema rodando.

## 1. Resumo executivo

- A tela da captura (Orçamentos / Pedidos / Aguardando Expedição / Expedidos / Cancelados, filtros Cliente e Representante) é gerada por `frontend/erp/js/pedidos.js` (`loadPedidos`), aberta pelo menu **Comercial → Pedidos** (`data-page="pedidos"`). [CÓD]
- Ela é o módulo **Pedido/Orçamento da Sprint 3.5/3.14, vinculado ao faturamento/expedição legado** (estados `AGUARDANDO_FATURAMENTO` / `FATURADO` rotulados como "Aguardando Expedição" / "Expedido"). Não encontrei no repositório uma interface nova de Pedido por mesa, nem desconectada nem conectada. [CÓD]
- **Mesa não existe** em nenhum ponto do código (UI, API, serviço, schema). Só há menção textual em `docs/arquitetura/ARQUITETURA_MOTOR_UNIVERSAL_VENDAS_V1.md:31` ("cabe mesa/comanda"). Não há modelo aprovado de mesa localizado. → **PENDÊNCIA DE DECISÃO**.
- **Cliente já é opcional** em todas as camadas lidas (UI, rota, serviço, schema). [CÓD] + [TESTE parcial]
- O elo **Pedido → composição fiscal → PDV oficial → conclusão não existe**: `ComposicaoFiscalPedidoService` não é referenciado por nenhuma rota, serviço de pedido ou tela; o PDV oficial (`frontend/pdv`) não lê pedidos. O pedido segue direto para o faturamento legado, que cria a venda via `VendaApplicationService`. [CÓD]
- Principal indício de bloqueio: `pedidos.js` usa `fetch` só com `Authorization`, **sem `X-Empresa-Id`**, e o serviço exige empresa no contexto até para listar. Pela leitura do código, a tela receberia erro 400. **Não confirmado em execução.**
- Menu "PDV Universal" (congelado) aparece como primeiro item e como PDV principal; `/pdv` aparece como "PDV legado" — invertido em relação ao contrato.

## 2. Inventário das telas

**Critério de contagem:** itens de navegação acessíveis + páginas HTML autônomas. Contados: 42 entradas `data-page` do ERP + 2 atalhos de PDV no menu ERP + 8 entradas `data-page` do menu do PDV + 1 PDV Universal + 1 login = **54 telas/entradas**. Excluídos: `frontend/notas-fiscais.html` (0 KB), plugins e snippets (não são telas de navegação).

**Profundidade:** apenas **Pedidos** foi lida de ponta a ponta (UI → rota → serviço → repositório → schema). Demais telas foram inventariadas por navegação, despacho em `app.js` e função de carga, **sem leitura funcional completa**. Não afirmo conformidade além do que consta na coluna Verificado.

| Grupo | Tela (`data-page`) | Arquivo/despacho | Verificado |
|---|---|---|---|
| Painel | dashboard, mis, monitoring | `app.js` → módulos JS; `pages/dashboard.html` | só navegação |
| Comercial | **pedidos** | `erp/js/pedidos.js` | UI+API+serviço+schema |
| Comercial | faturamento ("Expedição") | `erp/js/faturamento.js` → `/api/faturamento/*` | endpoints e criação da venda |
| Comercial | vendas, entregas, central-faturamento, caixa | `vendas.js`, `entregas`, `central-faturamento`, `caixa.js` | só navegação |
| Comercial | PDV Universal `/pdv-universal/`, PDV legado `/pdv` | `server.js:216-226` | rótulos e rotas |
| Suprimentos | produtos, **insumos**, categorias | `produtos.js` (`loadInsumos` em :739) | despacho |
| Suprimentos | compras, central-entradas, fornecedores | `compras.js:1762`, `central-entradas.js` | despacho (Central **não reaberta**) |
| Financeiro | financeiro, contas-bancarias, caixas | `pages/financeiro.html` etc. | só navegação |
| Cadastros | clientes | `clientes.js` | só navegação |
| Fiscal | fiscal, nfe-avulsa, nfe-central, nfe-monitor, nfe-fila, nfe-diagnostico, central-contabil | módulos `nfe-*` | só navegação |
| Sistema | configuracoes, configuracoes-avancadas, usuarios, licenca, auditoria, observabilidade, mib-analytics, enterprise-search, knowledge-center, cip-insights, cds-copiloto, central-equipamentos, laboratorio-equipamentos, enviar-produtos-balanca, central-diagnostico, dfe-auditoria | módulos JS correspondentes | só navegação |
| PDV `/pdv` | pdv, entregas, consulta, clientes, caixa, reimpressao, nome-terminal-pdv, configuracao-rede | `frontend/pdv/index.html`, `pages/pdv.html`, `js/pdv.js` | só navegação |
| Legado | PDV Universal | `frontend/pdv-universal/*` | congelado (doc 05.75) |
| Acesso | login | `frontend/shared/login.html` | — |

Ficha técnica: **não é tela de navegação própria**; é seção do formulário de produto (`produtos.js` ~2483–2534, `/produtos/:id/ficha-tecnica`).
Estoque: **não há entrada de menu "Estoque"** em `erp/index.html`. Não verificado se é exposto em outro ponto.

## 3. Mapa de navegação e rotas

- Menu ERP: `frontend/erp/index.html` (grupos Painel, Comercial, Suprimentos, Financeiro, Cadastros, Fiscal, Sistema). Despacho `data-page` → função `loadX()` em `frontend/erp/js/app.js` (`case 'pedidos'` ~426, `case 'faturamento'` ~418, `case 'insumos'` ~382). Visibilidade por `data-recurso` em `shared/js/core.js`. [CÓD]
- Backend (`backend/server.js`): `/api/pedidos` (:212, `exigirRecurso('pedidos')`), `/api/faturamento` (:210), `/api/vendas` (:208-209), `/api/pdv-universal` (:205), HTML `/pdv` (:216) e `/pdv-universal` (:222). [CÓD]
- Menu ERP Comercial: **PDV Universal** (`/pdv-universal/`, destaque verde, `#nav-abrir-pdv`), **PDV legado** (`/pdv`), Histórico de Vendas, Entregas, **Pedidos**, **Expedição**, Central de Faturamento, Fechamento de Caixa.
- `docs/arquitetura/ISOLAMENTO_PDV_UNIVERSAL_05_75.md` e `shared/js/pdv-acesso-oficial.js:3` definem: `/pdv-universal` = **congelado/legado**; `/pdv` = **oficial em evolução**.

## 4. Diagnóstico da tela de Pedidos (captura)

1. **HTML/componente:** não há HTML dedicado; `loadPedidos()` em `frontend/erp/js/pedidos.js` renderiza em `#page-content`, com cabeçalho `CdsPageShell.renderHeader({page:'pedidos'})` (`shared/js/cds-page-shell.js:28`). Carregamento do script: `app.js:60`.
2. **JS de eventos/listagem:** o mesmo arquivo (~1288 linhas): `carregarLista`, `salvarPedido`, `cancelarPedido`, `duplicarPedido`, `converterPedido`, `excluirOrcamento`, `enviarFaturamento`, `imprimirPedidoPorId`.
3. **Abas → endpoint** (todas `GET /api/pedidos?status=...&cliente=&representante=&dataInicio=&dataFim=`):

| Aba | `status` | Rótulo mostrado |
|---|---|---|
| Orçamentos | `ORCAMENTO` | Orçamento |
| Pedidos | `PEDIDO,ABERTO,EM_SEPARACAO` | Pedido / Em separação |
| Aguardando Expedição | `AGUARDANDO_FATURAMENTO` | Aguardando Expedição |
| Expedidos | `FATURADO` | Expedido |
| Cancelados | `CANCELADO` | Cancelado |

   Serviço: `backend/rotas/pedidos.js` → `services/pedido/PedidoOperacionalService.js` → `PedidoRepository.js`.
4. **Fluxo aprovado ou legado?** Corresponde ao módulo **Pedido/Faturamento da Sprint 3.x** (cabeçalho de `services/pedido/enums.js`: `ORCAMENTO → PEDIDO → AGUARDANDO_FATURAMENTO → FATURADO | CANCELADO`). Não identifica mesa, não alimenta composição fiscal nem PDV oficial. Divergente do fluxo aprovado em identificação (cliente/representante) e destino (Expedição).
5. **Interface nova não conectada:** busca por `mesa`, `comanda`, tela de pedido em `frontend/pdv` e HTML novo de pedidos: **nada encontrado**. O único pedido ligado ao PDV é `venda.pedido_id` exibido em `pdv/js/vendas.js:176` (vínculo vindo do faturamento).
6. **Fluxos concorrentes:** criação em Pedidos (`POST /api/pedidos`); criação a partir da Expedição (`POST /api/faturamento/pedidos`, `faturamento.js:1350`); venda direta no PDV; venda de entrega. Conversão orçamento→pedido, duplicação e exclusão só em Pedidos. Expedir = `POST /api/pedidos/:id/enviar-faturamento` e depois `POST /api/faturamento/pedidos/:id/faturar`.
7. **Uso de regras legadas:** sim. "Enviar" exige módulo Expedição contratado (`expedicaoHabilitada()`), o status final é `FATURADO`, e `FaturamentoService.js:125-180` monta a venda (`origem: FATURAMENTO`, `tipo_venda: 'BALCAO'`) via `VendaApplicationService.criarVendaComContexto`, sem composição fiscal nem PDV oficial.
8. **Alterações mínimas para o planejamento aprovado:** ver seção 10. Dependem de decisões da seção 11.

## 5. Mesa e cliente opcional

| Verificação | Evidência | Resultado |
|---|---|---|
| Campo/tabela de mesa | grep `mesa` em `backend/`, `frontend/`, `docs/`: só `ARQUITETURA_MOTOR_UNIVERSAL_VENDAS_V1.md:31`; os demais resultados são "mês" (`cds-monitoring-engine.js`) | **Inexistente** |
| Schema aceita pedido sem cliente | `database.js:3681`: `cliente_id INTEGER` sem `NOT NULL` | **Sim** |
| Rota/serviço | `PedidoOperacionalService.js:107`: `clienteId` = `null` se ausente; sem `throw` por cliente | **Sim** |
| UI | `pedidos.js` `salvarPedido`: só valida "Adicione ao menos um item"; `cliente_id` vai `null` | **Sim** |
| Listagem | `pedidos.js` lista: `p.cliente_nome \|\| 'Consumidor'`; `LEFT JOIN clientes` em `PedidoRepository.js` | **Exibe "Consumidor"** |
| Etapa posterior | `FaturamentoService.js:125`: `cliente_id: pedido.cliente_id \|\| null` | **Propaga null** |
| Teste | `tests/pedidos/pedido-operacional-sprint-b1.test.js:100` usa `clienteId: null`; teste passou (exit 0) | cobre o serviço; **não executa a UI** |

Observação: o campo "Representante" (texto livre, `representante_nome`) é a única identificação alternativa hoje. **Nenhuma regra de ocupação de mesa foi inventada.**

Não verificado: se alguma validação do **faturamento/NF-e** (CPF/cliente) exige cliente em etapas fiscais posteriores. Fora da leitura realizada.

## 6. Mapa interface → API → serviço (Pedidos)

| Ação (UI) | Endpoint | Serviço |
|---|---|---|
| Listar | `GET /api/pedidos` | `PedidoOperacional.listar` |
| Abrir/editar | `GET/PUT /api/pedidos/:id` | `obter` / `atualizar` |
| Salvar novo | `POST /api/pedidos` | `criar` (confirma estoque via Motor Comercial) |
| Cancelar | `POST /api/pedidos/:id/cancelar` | `cancelar` |
| Duplicar | `POST /api/pedidos/:id/duplicar` | `duplicar` |
| Converter | `POST /api/pedidos/:id/converter` | `converterParaPedido` |
| Excluir orçamento | `DELETE /api/pedidos/:id` | `excluir` |
| Enviar p/ Expedição | `POST /api/pedidos/:id/enviar-faturamento` | `enviarParaFaturamento` |
| Expedir | `POST /api/faturamento/pedidos/:id/faturar` | `FaturamentoService.faturarPedido` → `VendaApplicationService` |

Estados de UI em `carregarLista`: carregando ("Carregando…"), vazio ("Nenhum registro encontrado."), erro (`alertar`). Tratados. [CÓD]

## 7. Telas antigas, duplicadas, desconectadas

- **PDV Universal** (`frontend/pdv-universal`): legado congelado, ainda promovido no menu ERP (`index.html:75`) e no menu do PDV (`pdv/index.html:69`).
- **Entregas**: aparece em duas navegações (ERP e PDV). Não analisado se são a mesma tela.
- **Clientes e Caixa**: aparecem no menu ERP e no menu do PDV. Não analisado.
- **Insumos** (`index.html:125-130`) e **CSP** (`index.html:6`) são alterações locais preexistentes e não commitadas; preservadas, sem validação aqui.
- Pedido/Orçamento: sem tela concorrente para mesa.

## 8. Achados e classificação

| # | Classe | Achado | Evidência |
|---|---|---|---|
| A1 | **BLOQUEADOR** (código; runtime não confirmado) | Chamadas de `pedidos.js` não enviam `X-Empresa-Id`; o serviço exige empresa também no `GET` (`empresaDoContexto` em `PedidoOperacionalService.js:180`, erro `Empresa do contexto é obrigatória`, 400). `$.ajaxSetup` (`core.js:1139`) cobre só jQuery, não `fetch`. `PedidoEmpresaContextoService.js:133-145` não tem fallback | `pedidos.js:187-191` (headers sem empresa); `empresaContexto.js:121-129` |
| A2 | **INTEGRAÇÃO AUSENTE** | Composição fiscal não conectada: `ComposicaoFiscalPedidoService` só é requerido em testes e por si mesmo | grep em `backend/` e `frontend/` |
| A3 | **INTEGRAÇÃO AUSENTE** | PDV oficial não recebe pedido; não há importação de pedido em `frontend/pdv` | grep `pedido` em `frontend/pdv` |
| A4 | **DIVERGÊNCIA DE ESCOPO** | Pedido termina em Expedição/Faturamento legado, que cria a venda (`origem: FATURAMENTO`) sem composição nem PDV oficial | `FaturamentoService.js:125-180`; `pedidos.js` `enviarFaturamento` |
| A5 | **DIVERGÊNCIA DE ESCOPO** | Menu destaca PDV Universal (congelado) e rotula `/pdv` como "PDV legado" | `erp/index.html:75-80`; `pdv-acesso-oficial.js:3`; doc 05.75 |
| A6 | **PENDÊNCIA DE DECISÃO** | Mesa inexistente; sem modelo aprovado localizado (coluna em `pedidos`? tabela? campo livre?) | seção 5 |
| A7 | **PENDÊNCIA DE DECISÃO** | Mapeamento dos estados do pedido (`PEDIDO`, `AGUARDANDO_FATURAMENTO`, `FATURADO`) para o fluxo composição→PDV→conclusão; Orçamento existe e não consta no fluxo aprovado | `enums.js`; abas de `pedidos.js` |
| A8 | **CONFORME** | Cliente opcional ponta a ponta (schema, serviço, UI, listagem) | seção 5 |
| A9 | **CONFORME** | Rotas de Pedido com contexto de empresa validado no backend, sem fallback | `PedidoEmpresaContextoService.js:132`; `empresaIdDoReqPedido.js` |
| A10 | **LEGADO ISOLADO** | Faturamento/Expedição, Central de Faturamento e PDV Universal: preservar; não expandir | docs 05.75; `faturamento.js` |
| A11 | **BLOQUEIO NÃO DETERMINADO** (observado em [TESTE]) | 2 testes de interface/rota de Pedidos falham no estado atual do workspace (seção 12). `PedidoRepository.js` tem 157 linhas de alteração local preexistente não relacionadas às sprints de preço | seção 12 |

## 9. Matriz de conformidade com o fluxo aprovado

| Etapa | Estado | Base |
|---|---|---|
| Pedido operacional como origem de itens, quantidades, preços, total | Parcial: existe, mas sem mesa e com preço digitado na UI (não vem da cotação) | A6; `pedidos.js` |
| Cliente opcional | Conforme | A8 |
| Mesa como identificação | Ausente | A6 |
| Pedido → composição fiscal | Ausente | A2 |
| Composição → PDV oficial | Ausente | A3 |
| PDV oficial → conclusão transacional | Fora desta etapa (não iniciada, conforme instrução) | — |
| PDV Universal como legado | Divergente no menu | A5 |
| Faturamento/Expedição legado preservado | Conforme (inalterado) | A10 |
| Contexto de empresa explícito | Backend conforme; frontend de Pedidos sem header | A1, A9 |

## 10. Correções estritamente necessárias (priorizadas; **não implementadas**)

1. **Confirmar A1 em execução** e, se confirmado, enviar o contexto de empresa em `pedidos.js` usando `CdsEmpresaContexto.headersJson()` (padrão já usado em `produtos.js:5526`, `pdv.js:422`). Verificar o mesmo em `faturamento.js`.
2. **Decidir e documentar o modelo de mesa** (A6) antes de qualquer campo ou validação.
3. **Decidir o mapeamento de estados** (A7) e o ponto de entrada do Pedido na composição fiscal (A2/A3).
4. **Corrigir a ordem/rotulagem de PDV** no menu (A5), sem remover o Universal.
5. Investigar as duas falhas de teste (A11), sem enfraquecer as expectativas.

## 11. Decisões que exigem aprovação

- Onde e como a mesa é guardada e exibida (campo em `pedidos`, tabela, ou outro); ocupação, transferência e fechamento de mesa continuam **indefinidos**.
- O Orçamento permanece no fluxo operacional?
- Rótulos "Aguardando Expedição" / "Expedido" permanecem?
- Quem inicia a composição fiscal (Pedido ou PDV) e como se evita duplicar efeitos operacionais (reserva de estoque na criação do Pedido, `confirmarEstoqueViaMotorComercial`).
- Se o campo Representante deve permanecer na tela de pedidos operacionais.

## 12. Testes executados e limitações

Comandos (um `DB_DIR` temporário por execução, removido ao final; banco oficial não tocado):

| Teste | Resultado real |
|---|---|
| `tests/pedidos/pedido-operacional-sprint-b1.test.js` | exit 0 |
| `tests/faturamento/sprint36-pedidos-ux.test.js` | exit 0 |
| `tests/faturamento/sprint35-pedidos-ui.test.js` | **exit 1**: 3 pass, 1 fail ("menu Pedidos + loadPage + script": a regex `/page === 'pedidos'/` não casa com `shared/js/core.js`) |
| `tests/faturamento/sprint314-orcamento-pedidos.test.js` | **exit 1**: 6 pass, 1 fail ("fila de faturamento continua só AGUARDANDO_FATURAMENTO": a regex `/WHERE p\.status IN \('AGUARDANDO_FATURAMENTO'\)/` não casa com `PedidoRepository.js` atual, embora o trecho `p.status IN ('AGUARDANDO_FATURAMENTO')` exista na linha 133) |

As duas falhas são verificações estáticas de texto. A causa não foi investigada além disso; **não comprovei** relação com as sprints de preço (os arquivos testados não foram alterados por elas).

Limitações:
- Sem execução real (navegador/servidor): nenhuma afirmação de comportamento visual ou de clique.
- Apenas Pedidos foi lida em profundidade; as demais 50+ entradas foram inventariadas por navegação.
- Não foram lidos Financeiro, Estoque, Cadastro de empresas e Configurações a fundo; nada foi afirmado sobre eles além da navegação.
- Central de Entradas: não reaberta. Nenhuma dependência bloqueadora direta registrada.
- Suíte completa não reexecutada nesta etapa (a última rodada, da Sprint 2.7: 530 passam, 120 falham; falhas fora de escopo não investigadas).

## 13. Confirmação

Único arquivo criado nesta etapa: este relatório. Nenhum código, banco, schema, endpoint, navegação ou dado foi modificado. Alterações locais preexistentes preservadas.
