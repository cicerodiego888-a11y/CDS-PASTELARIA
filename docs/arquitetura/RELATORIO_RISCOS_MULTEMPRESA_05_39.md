# RELATÓRIO DE RISCOS MULTIEMPRESA — Sprint 05.39

**STATUS:** AUDITORIA — SOMENTE LEITURA  
**Data:** 2026-08-24  
**Escopo:** riscos comprovados no código. Teste passando **não** reclassifica fluxo.

---

# 🔴 RISCOS CONFIRMADOS

Somente problemas com evidência de arquivo/função/linha e cenário de falha real em `MULTIEMPRESA`.

---

### ID: R-05.39-01
**DOMÍNIO:** Vendas (leitura)  
**ARQUIVO:** `backend/rotas/vendas.js`  
**LINHA:** 50-134  
**DESCRIÇÃO:** `GET /api/vendas` monta SQL sem `empresa_id` e sem join em `caixa_sessoes.empresa_id`. Middleware de contexto é opcional (`:47`) e o `req.empresaId` não entra no WHERE.  
**CENÁRIO DE FALHA:** Operador da Empresa A lista vendas e vê (e pode abrir) vendas da Empresa B.  
**EMPRESAS ENVOLVIDAS:** A (contexto) lê B (dados).  
**IMPACTO:** Quebra de isolamento de operação/financeiro visível na UI.  
**RECOMENDAÇÃO:** Próxima sprint — filtrar por ownership persistido (hoje inexistente em `vendas`) ou por `caixa_sessoes.empresa_id` / `atendimento_operacoes.empresa_id`.

---

### ID: R-05.39-02
**DOMÍNIO:** Cancelamento de venda  
**ARQUIVO:** `backend/services/vendas/VendaCancelamentoService.js`  
**LINHA:** 51-52 (localização); estoque via `creditoEstoqueVendaViaPorta.js:40-46`, `:70-75`  
**DESCRIÇÃO:** Cancelamento busca venda só por `id`. Não compara empresa. Crédito de estoque usa `req.empresaId` do HTTP atual ou `modoLegadoSemEmpresa`.  
**CENÁRIO DE FALHA:** Venda da Empresa A cancelada com contexto da Empresa B → estoque creditado em B (ou em `produtos` global).  
**EMPRESAS ENVOLVIDAS:** A (venda original) vs B (contexto do cancelamento).  
**IMPACTO:** Estoque cruzado; financeiro de estorno sem `empresa_id` (ver R-05.39-04).  
**RECOMENDAÇÃO:** Exigir empresa da operação original e recusar divergência; persistir `empresa_id` na venda.

---

### ID: R-05.39-03
**DOMÍNIO:** Devolução de venda  
**ARQUIVO:** `backend/services/vendas/VendaDevolucaoService.js`  
**LINHA:** 239 (`SELECT vendas WHERE id=?`); 253 (`montarOpcoesRetornoEstoqueVenda`); 366-368 (financeiro sem `empresaId`)  
**DESCRIÇÃO:** Mesmo padrão do cancelamento. `vendas_devolucoes` sem `empresa_id` (`database.js:1818`). UI `modalDevolucaoVenda.js:152` não exige `X-Empresa-Id`.  
**CENÁRIO DE FALHA:** Devolução da venda A com contexto B credita estoque B e/ou lotes globais.  
**EMPRESAS ENVOLVIDAS:** A vs B.  
**IMPACTO:** Estoque e financeiro cruzados.  
**RECOMENDAÇÃO:** Amarrar devolução à empresa proprietária da venda original.

---

### ID: R-05.39-04
**DOMÍNIO:** Financeiro  
**ARQUIVO:** `backend/services/vendas/VendaCancelamentoService.js`  
**LINHA:** 117-121 INSERT estorno sem `empresa_id`; `VendaFinanceiroService.js:107-118` UPDATE por `venda_id` sem filtro empresa  
**DESCRIÇÃO:** Estorno de cancelamento não grava ownership. Cancelamento financeiro atinge qualquer linha `financeiro` da venda, inclusive de outra empresa se houver lixo/NULL.  
**CENÁRIO DE FALHA:** Relatórios financeiros da Empresa B incluem ou omitem estorno da venda A; linhas `empresa_id IS NULL` aparecem em qualquer filtro frouxo.  
**EMPRESAS ENVOLVIDAS:** A (venda) vs consolidado.  
**IMPACTO:** DRE/caixa por empresa incorretos.  
**RECOMENDAÇÃO:** Gravar `empresa_id` no estorno a partir da operação original (não do request).

---

### ID: R-05.39-05
**DOMÍNIO:** Materialização MUV / Financeiro  
**ARQUIVO:** `backend/motores/muv/MaterializarOperacoesAtendimento.js`  
**LINHA:** 226-231  
**DESCRIÇÃO:** `empresaId` está na operação (`:164`) mas o INSERT em `financeiro` não inclui a coluna. Diverge de `VendaPagamentoService.js:1642-1660`, que grava `empresa_id`.  
**CENÁRIO DE FALHA:** Atendimento MULTI da Empresa A materializa receita financeira sem ownership; listagens 05.38.D filtradas por `empresa_id` **não veem** a receita.  
**EMPRESAS ENVOLVIDAS:** A (operação) vs consolidado/NULL.  
**IMPACTO:** Furo financeiro no isolamento que as rotas ERP já implementam.  
**RECOMENDAÇÃO:** Persistir `empresa_id = operacao.empresaId` no INSERT (sprint de correção).

---

### ID: R-05.39-06
**DOMÍNIO:** Fiscal / NFC-e  
**ARQUIVO:** `backend/services/vendas/VendaFiscalService.js`  
**LINHA:** 211 `emitirPorVendaId(payload.vendaId)` sem `empresaId`; `emissor.js:210-218`; `rotas/fiscal.js:261-264`  
**DESCRIÇÃO:** Caminho pós-venda e rota manual usam `getFiscalConfig()` global (`configService.js:98-198`): certificado, CSC, URLs, CNPJ da instalação.  
**CENÁRIO DE FALHA:** Empresa A vende no PDV Express/Universal EU; NFC-e sai com CSC/certificado da config global (possivelmente da Empresa B).  
**EMPRESAS ENVOLVIDAS:** A (venda) vs B/global (credenciais).  
**IMPACTO:** Documento fiscal inválido / uso de certificado alheio.  
**RECOMENDAÇÃO:** Passar `empresaId` da operação (caixa_sessao / atendimento) para `emitirPorVendaId`; bloquear fallback global em MULTI (já feito só no MUV `:282-288`).

---

### ID: R-05.39-07
**DOMÍNIO:** Cancelamento fiscal NFC-e  
**ARQUIVO:** `backend/services/fiscal/cancelarNfce.js`  
**LINHA:** 9-10 `const config = await getFiscalConfig();`  
**DESCRIÇÃO:** Evento 110111 assinado com certificado/CNPJ **global**, não com `nfce_notas.empresa_id` nem com a empresa da venda.  
**CENÁRIO DE FALHA:** Nota emitida (MUV) com config da Empresa A é cancelada com credencial global da Empresa B → rejeição SEFAZ ou cancelamento indevido.  
**EMPRESAS ENVOLVIDAS:** A (nota) vs global/B.  
**IMPACTO:** Falha fiscal ou cancelamento com CNPJ errado.  
**RECOMENDAÇÃO:** Resolver config pela `empresa_id` da nota; recusar se ausente em MULTI.

---

### ID: R-05.39-08
**DOMÍNIO:** Caixa  
**ARQUIVO:** `backend/utils/caixaSessaoHelpers.js`  
**LINHA:** 37-39  
**DESCRIÇÃO:** Sem `empresaId` e sem `sessaoId`, SQL é `SELECT * FROM caixa_sessoes WHERE status='aberto' ORDER BY id DESC LIMIT 1`.  
**CENÁRIO DE FALHA:** Dois caixas abertos (A e B); request sem header pega o mais recente, de qualquer empresa.  
**EMPRESAS ENVOLVIDAS:** A e B.  
**IMPACTO:** Sangria/venda/fechamento no caixa errado.  
**RECOMENDAÇÃO:** Em MULTI, recusar lookup sem `empresa_id`; nunca LIMIT 1 global.

---

### ID: R-05.39-09
**DOMÍNIO:** Caixa legado  
**ARQUIVO:** `backend/rotas/caixa.js`  
**LINHA:** 117-121  
**DESCRIÇÃO:** `SELECT * FROM caixa WHERE status='aberto' ORDER BY id DESC LIMIT 1`. Tabela `caixa` sem `empresa_id` (`database.js:3105`).  
**CENÁRIO DE FALHA:** Turno legado compartilhado entre empresas.  
**EMPRESAS ENVOLVIDAS:** A e B.  
**IMPACTO:** Mesmo que `caixa_sessoes` esteja isolado, código legado ainda resolve turno global.  
**RECOMENDAÇÃO:** Isolar ou desativar caminho `caixa` em MULTI.

---

### ID: R-05.39-10
**DOMÍNIO:** Reservas de pedido  
**ARQUIVO:** `backend/services/fiscalNaoFiscal/reservasPublico.js`  
**LINHA:** 354-365 (criar); 425 (liberar)  
**DESCRIÇÃO:** `_criarReservaTipo` / `liberarReservasPedido` chamam `_aplicarDeltaReservado` **sem** `espelharReservadoEmEstoqueEmpresa`. O caminho PDV correto (`ajustarReservado` `:519-522`) faz o espelho. Tracking `pedido_estoque_reservas` sem `empresa_id`.  
**CENÁRIO DE FALHA:** Pedido da Empresa A reserva quantidade só em `produtos.reservado_*`. Leitura MULTI de A via `estoque_empresa.reservado_*` fica defasada → **oversell** na Empresa A. Empresa B em COMPAT vê reservado global inflado.  
**EMPRESAS ENVOLVIDAS:** A (pedido) vs B (leitura legado) e A (leitura isolada incorreta).  
**IMPACTO:** Super-venda / estoque fantasma.  
**RECOMENDAÇÃO:** Unificar criar/liberar pedido no mesmo writer de `ajustarReservado`.

---

### ID: R-05.39-11
**DOMÍNIO:** Lotes  
**ARQUIVO:** `backend/services/lotesService.js`  
**LINHA:** 121-148 `consumirLotesFEFO`; 355-360 `atualizarEstoqueConsolidado`  
**DESCRIÇÃO:** `produtos_lotes` sem `empresa_id` (`database.js:1245-1261`). FEFO consome por `produto_id` apenas. `atualizarEstoqueConsolidado` faz UPDATE em `produtos` fora da porta pública.  
**CENÁRIO DE FALHA:** Empresa A e B vendem o mesmo SKU; FEFO da A consome lote que a B deu entrada.  
**EMPRESAS ENVOLVIDAS:** A e B (mesmo produto compartilhado).  
**IMPACTO:** Rastreio de lote e validade cruzados; `estoque_atual` global adulterado.  
**RECOMENDAÇÃO:** Ownership de lote por empresa **ou** regra explícita de lote compartilhado (decisão arquitetural — não implementar nesta sprint).

---

### ID: R-05.39-12
**DOMÍNIO:** SEFAZ / DF-e  
**ARQUIVO:** `backend/services/fiscal/distribuicaoDFe.js`  
**LINHA:** 211 assinatura; 319-326 uso de `deps`  
**DESCRIÇÃO:** `persistirDocumentosRetorno(xmlRetorno, persistencia, origem, ctxAudit)` não recebe `deps`, mas o corpo lê `deps.contextoCentral?.empresaId`. `ReferenceError` cai no `catch` (`:327`) e incrementa `ignorados`.  
**CENÁRIO DE FALHA:** DistDFe retorna XML; documentos do ZIP não são persistidos (ou persistem só se outro caminho for usado); `empresa_id` planejado nunca é aplicado neste loop.  
**EMPRESAS ENVOLVIDAS:** Alvo de sync A/B vs inbox vazia/errada.  
**IMPACTO:** Central de Entradas deixa de gravar DF-e; NSU pode avançar dessincronizado do documento.  
**RECOMENDAÇÃO:** Correção pontual do parâmetro (próxima sprint). Não “consertar preventivamente” outros trechos agora.

---

### ID: R-05.39-13
**DOMÍNIO:** Central de Entradas  
**ARQUIVO:** `backend/rotas/central-entradas.js`  
**LINHA:** 695 `POST /:id/processar`; 922 revisar; 946 abrir-compra; 1007 `GET /:id`  
**DESCRIÇÃO:** Operações por ID não checam `documento.empresa_id` contra `X-Empresa-Id` / contrato. `GET /` filtra empresa só se o header existir (`:628-630`).  
**CENÁRIO DE FALHA:** Usuário da Empresa A, autenticado, chama `GET /central-entradas/42` do documento da Empresa B e processa/abre compra.  
**EMPRESAS ENVOLVIDAS:** A (operador) vs B (documento).  
**IMPACTO:** Compra/estoque da B a partir de ação da A (se o bridge usar `empresa_id` do documento, a **gravação** pode ir para B — operação cruzada de **quem** executa; se o contexto HTTP sobrescrever, gravação vai para A).  
**RECOMENDAÇÃO:** `exigirDocumentoDaEmpresa` em todas as rotas por ID, análogo a `exigirCompraDaEmpresa`.

---

### ID: R-05.39-14
**DOMÍNIO:** Financeiro (devolução)  
**ARQUIVO:** `backend/services/vendas/VendaFinanceiroService.js`  
**LINHA:** 344 `opcoes.empresaId || null`; caller `VendaDevolucaoService.js:366-368` não passa empresa  
**DESCRIÇÃO:** Estorno de devolução persiste `empresa_id` NULL.  
**CENÁRIO DE FALHA:** Relatório da Empresa A não mostra o estorno; consolidado “sem empresa” mistura A e B.  
**EMPRESAS ENVOLVIDAS:** A vs NULL.  
**IMPACTO:** Isolamento financeiro furado no caminho de devolução.  
**RECOMENDAÇÃO:** Propagar empresa da venda original (após existir ownership na venda).

---

### ID: R-05.39-15
**DOMÍNIO:** Schema de vendas (fundação)  
**ARQUIVO:** `backend/database.js`  
**LINHA:** 1838-1858 CREATE `vendas`; ALTERs 145-437 sem `empresa_id`  
**DESCRIÇÃO:** A linha transacional canônica **não tem** coluna de ownership. Writers W1/W2/W3 não gravam empresa. Isolamento posterior (cancel, devolução, listagem, fiscal legado, NFC-e) **não tem de onde ler** a empresa da venda.  
**CENÁRIO DE FALHA:** Qualquer recuperação posterior (“qual empresa fez esta venda?”) depende de join indireto (`caixa_sessao_id` ou `atendimento_operacoes.venda_id`), ambos opcionais/ausentes em parte das origens (entrega/MUV sem caixa).  
**EMPRESAS ENVOLVIDAS:** Todas.  
**IMPACTO:** Gap estrutural que **habilita** R-05.39-01 a 07 e 14.  
**RECOMENDAÇÃO:** Decisão arquitetural de persistir `vendas.empresa_id` — **não** nesta sprint.

---

# 🟡 PONTOS PARCIAIS

| ID | Domínio | Evidência | Por que não é 🔴 |
|----|---------|-----------|------------------|
| P-01 | Contexto HTTP | `empresaContexto.js:90-106` header/body/query | Extração correta quando presente; risco só se ausente (🟠 middleware) |
| P-02 | Venda legado INSERT | `VendaPagamentoService` grava financeiro com `empresa_id` mas não a venda | Runtime isolado se header ok; persistência da venda falha |
| P-03 | Checkout Universal EU | Contexto validado; writer legado | Seguro na sessão; venda sem coluna |
| P-04 | Materializar venda | `operacao.empresaId` validado nos itens/reservas | Venda órfã; financeiro é 🔴 |
| P-05 | Estoque dual-write | `_ajustarSaldo` espelha se empresa e não-legado | `produtos` continua writer primário |
| P-06 | Reserva PDV | Dual-write via `ajustarReservado`; tracking sem coluna | Efeito isolado; auditoria de reserva não empresarial |
| P-07 | Consumo PDV | Porta com `empresaId` opcional | COMPAT possível |
| P-08 | Financeiro venda à vista | `req.empresaId \|\| null` | Rotas ERP 🟢; NULL é furo |
| P-09 | Caixa movimentações | Sem coluna; herdam `sessao_id` | Sessão tem `empresa_id` quando abertura 05.38.C |
| P-10 | Caixa vs venda | Vínculo `caixa_sessao_id` | Não inequívoco (ver pergunta obrigatória) |
| P-11 | `nfce_notas.empresa_id` | ALTER runtime; caller legado grava NULL | MUV preenche |
| P-12 | Produtos overlay | Listagem com `estoque_empresa` | Cadastro global (oficial) |
| P-13 | Saldo inicial | Empresa opcional; sem localização | Não cruza se header presente |
| P-14 | Chave NF compras | Unique global `:1828` | Bloqueia, não grava no estoque errado |
| P-15 | Upload Central | Resolve por CNPJ dest | Rota não passa header |
| P-16 | Listagem Central | Filtro opcional | Consolidado se sem header |
| P-17 | MIIP global | Sem `empresa_id` | Coerente com catálogo compartilhado |
| P-18 | Consulta DF-e por chave | Persistência sem `empresaId` | Orquestração sync é 🟢 |
| P-19 | `nfe_notas` | Sem `empresa_id` | Modelo 55 não isolado |
| P-20 | Ajuste estoque histórico | `produtos_ajustes_estoque` sem empresa | Saldo via porta pode estar isolado |
| P-21 | Frontend localStorage | Estado só no cliente | Backend revalida vínculo quando header chega |

---

# 🟠 DEPENDÊNCIAS DE COMPATIBILIDADE

| ID | Mecanismo | Evidência | Efeito em MULTI |
|----|-----------|-----------|-----------------|
| C-01 | Middleware empresa opcional | `criarMiddlewareContextoEmpresa` `:122-131`; `rotas/vendas.js:47` | Opera com `req.empresaId = null` |
| C-02 | Auto-seleção 1 empresa | `cds-empresa-contexto.js:203-210`; PDV `UNICA_DISPONIVEL` | Mascaramento de seleção |
| C-03 | PDV Express → `/api/vendas` | `frontend/pdv/js/pdv.js:5091` | Sem itens empresariais; quebra se modo MULTI |
| C-04 | `modoLegadoSemEmpresa` | Portas estoque/reservas/crédito venda | Saldo em `produtos` global |
| C-05 | Herança `req.empresaId` da sessão de caixa | `validarCaixaAberto.js:114-116` | Empresa do caixa, não do header |
| C-06 | `getFiscalConfig()` GLOBAL | `configService.js:187-198` | Certificado/CSC da instalação |
| C-07 | Numeração NFC-e global | `incrementaNumeroFiscal` sem empresa | Série/número compartilhados |
| C-08 | Backfill 05.38 C–F | helpers caixa/financeiro/compras/central | NULL → operacional **só** se única/config; MULTI ambíguo permanece NULL |
| C-09 | `PoliticaEmpresaSimples` `UNICA_EMPRESA_ATIVA` | `:98-102` | Determinístico; N>1 bloqueia |

Não encontrado: `SELECT id FROM empresas LIMIT 1` como default operacional (positivo).  
`empresaContexto.js` documenta que **não** lê `configuracoes.cnpj` para assumir empresa 1.

---

# 🟢 FLUXOS SEGUROS

Ownership explícito ponta a ponta (no recorte auditado):

1. Contrato operacional SIMPLES/MULTI — `ContratoOperacionalService` / políticas (`:14-32`, `:77-110`, MULTI `null`).
2. Middleware de estoque `{ obrigatorio: true }` — `rotas/estoque.js:59`.
3. Contexto e seleção PDV Universal — `PDVUniversalContextService`.
4. Checkout MULTI / criar-reservar-pagar atendimento — `AtendimentoMultiempresaService` + `atendimento_operacoes.empresa_id NOT NULL`.
5. Fiscalização MUV — `FiscalizarAtendimentoService.js:282-288` (proíbe fallback global).
6. Consumo de reservas na materialização — `exigirEmpresa: true`.
7. Dual-write de **saldo** com `empresaId` e `legado !== true` — `estoqueSaldosPublico.js:313-315`.
8. Reserva MUV — `atendimento_operacao_reservas.empresa_id`.
9. Rotas Financeiro/Contas a receber 05.38.D — middleware + `exigirRegistroDaEmpresa`.
10. Abertura de caixa 05.38.C — INSERT `caixa_sessoes.empresa_id` + `exigirSessaoDaEmpresa` quando contexto presente.
11. Configuração fiscal **por empresa** (infra) — `empresas_configuracao_fiscal`.
12. Catálogo de produtos compartilhado — regra oficial, não é gap.
13. Compras: INSERT + listagem + cancelar + estoque + financeiro com `empresa_id`.
14. Sync DF-e por alvo empresarial — `listarAlvosSincronizacaoCentral` + persistência com `empresaId` no serviço.
15. NSU por `(cnpj, ambiente)`.

---

## Observação sobre testes

Suítes 05.38.B/C/D/E/F.B **passam** e cobrem isolamento das **rotas já migradas** (caixa, financeiro, compras, sync Central). Elas **não** cobrem listagem de vendas, cancelamento/devolução, emissão NFC-e legado, FEFO, reservas de pedido nem o bug `deps` em `distribuicaoDFe.js`. Teste verde ≠ fluxo seguro.
