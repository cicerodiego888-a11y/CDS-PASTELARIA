# AUDITORIA A1 — REAPROVEITAMENTO PDV OPERACIONAL

**Sprint:** 05.29.A.1 (somente auditoria)  
**Data:** 2026-08-23  
**Escopo:** PDV legado, PDV Universal, rotas/services diretamente alcançados  
**Proibido nesta sprint:** implementação, alteração de código, novos motores/APIs

---

## Legenda de classificação

| Código | Significado |
|--------|-------------|
| **R1** | REUTILIZAR DIRETAMENTE |
| **R2** | REUTILIZAR COM ADAPTAÇÃO |
| **R3** | EXTRAIR PARA COMPARTILHADO |
| **R4** | CONECTAR AO UNIVERSAL |
| **R5** | DUPLICADO / UNIFICAR |
| **R6** | OBSOLETO |
| **R7** | NÃO EXISTE / CRIAR FUTURAMENTE |

---

## Matriz oficial

| RECURSO | ARQUIVO ATUAL | FUNÇÃO/CLASSE | API | SERVICE/MOTOR | USADO NO LEGADO | USADO NO UNIVERSAL | SITUAÇÃO | DESTINO UNIVERSAL | CLASSIFICAÇÃO |
|---------|---------------|---------------|-----|---------------|-----------------|-------------------|----------|-------------------|---------------|
| Adicionar produto (código/PLU/nome) | `frontend/pdv/js/pdv.js` | `adicionarProdutoPorCodigoViaMip` → `identificarProdutoViaMip` | `POST /api/produtos/identificar` | MIP / SearchService via `backend/rotas/produtos.js` | Sim | Sim (`pdv-universal-identificacao.js:identificarEntradaPdv`) | Duas UIs; mesmo contrato identificar | Manter identificar; Universal já usa | **R1** |
| Busca autocomplete produto | `frontend/pdv/js/pdv.js` | `abrirConsultaProdutosPDV` / `pdvBuscaProduto.js` | `GET /api/produtos/consulta-pdv/buscar` | MIB SearchService | Sim | Sim (`pdv-universal.js:buscarProdutos`) | Duas UIs | Manter consulta-pdv | **R1** |
| Disponibilidade por empresa | — | — | `GET /api/pdv-universal/produtos/:id/disponibilidade` | `PDVUniversalDisponibilidadeService` | Não (legado usa cache produtos) | Sim | Exclusivo Universal | Manter | **R1** |
| Carrinho local | `frontend/pdv/js/pdv.js` | array `carrinho`, `adicionarItemNoCarrinho` | — | — | Sim | Sim (`pdv-universal-cart.js:criarCarrinho`) | Duplicado in-memory | Manter `PDVUniversalCart` como oficial Universal | **R5** |
| Identidade item carrinho | `frontend/pdv-universal/pdv-universal-cart.js` | `chaveItem(produto_id, empresa_id)` | — | — | Parcial (legado mono-empresa) | Sim | Universal mais rigoroso | Padrão oficial Universal | **R1** |
| Remover item | `frontend/pdv/js/pdv.js` | `removerItemCarrinho` | — | — | Sim | Sim (`removerItem`) | Duplicado UI | Universal OK | **R5** |
| Alterar quantidade inteira | `frontend/pdv/js/pdv.js` | handlers `.quantidade-item` | — | — | Sim | Sim (05.26) | Duplicado | Universal OK | **R5** |
| Quantidade decimal / peso | `frontend/pdv/js/pdv.js` | `abrirModalQuantidadeProduto`, `calcularItemEtiquetaBalancaPdv` | — | — | Sim | Sim (05.28 cart + 05.29 modal PESAR) | Legado + etiqueta; Universal manual | Conectar etiqueta depois | **R4** |
| Produto pesável (flag) | `backend/rotas/produtos.js` | `normalizarProdutoResposta` | consulta-pdv / identificar | `produto_fracionado` / `produto_pesavel` | Sim | Sim (propaga no add) | Campo oficial existe | Manter flags do backend | **R1** |
| Desconto / acréscimo venda | `frontend/pdv/js/pdv.js` | `#descontoPdv`, `#acrescimoPdv`, `MotorPrecoAtacado` | — | `motor-preco-atacado.js` | Sim (atacado + manual) | Sim (`calcularTotaisOperacionais` 05.22) | Legado mais rico (atacado) | Extrair atacado depois | **R2** |
| Desconto supervisor | `frontend/pdv/js/pdv.js` | `garantirAutorizacaoDesconto` | `POST /api/auth/supervisor/authorize` | auth | Sim | Não | Ausente Universal | Conectar quando necessário | **R4** |
| Subtotal / total | ambos frontends | cálculo local | — | — | Sim | Sim | Duplicado | Universal: `calcularTotaisOperacionais` | **R5** |
| Cancelar venda / carrinho | `frontend/pdv/js/pdv.js` | `cancelarVendaAtual` | `POST /api/tef/cancelar` (se TEF pendente) | `services/tef` | Sim | Sim (local + ESC) | Universal não cancela TEF pendente no cancel | Adaptar cancel TEF | **R2** |
| Novo atendimento pós-venda | `frontend/pdv-universal/pdv-universal.js` | reset sessão / `cart.limpar` | — | — | Parcial | Sim | Universal MULTIEMPRESA | Manter | **R1** |
| Atalho F1 busca | `pdv.js` / `pdv-universal.js` | focus busca | — | — | Sim | Sim | Equivalente | Manter | **R1** |
| Atalho F10 finalizar | `pdv.js` / `pdv-universal.js` | finalizar venda | — | — | Sim | Sim | Equivalente | Manter | **R1** |
| Atalho F7 caixa | `frontend/pdv/js/pdv.js` | `abrirFechamentoCaixa` → `loadPage('caixa')` | — | — | Sim | Botão disabled | Universal não navega caixa | Conectar UI caixa ERP/legado ou nova sprint | **R4** |
| Atalho F9 entrega | `frontend/pdv/js/pdv-venda-entrega.js` | `PdvVendaEntrega.aoClicarBotaoEntrega` | — | — | Sim | Não | Ausente Universal | Conectar backend entrega existente | **R4** |
| **Checkout venda balcão** | `frontend/pdv/js/pdv.js` | `executarFinalizacaoVenda` → `enviarVenda` | **`POST /api/vendas`** | `VendaApplicationService` → `VendaPagamentoService.criarVenda` | Sim | Não | Dois entrypoints | Universal usa checkout próprio | **R5** |
| **Checkout Universal** | `pdv-universal-checkout.js` | `finalizarCheckout` | **`POST /api/pdv-universal/checkout`** | `PDVUniversalApplicationService.finalizarCheckout` | Não | Sim | Oficial Universal | Manter | **R1** |
| Motor venda EMPRESA_UNICA | `backend/services/pdv-universal/PDVUniversalVendaAdapter.js` | `montarPayloadVendaOficial` | checkout | `EmpresaUnicaAdapter` → `VendaPagamentoService.criarVenda` | Indireto | Sim | **Mesmo núcleo** que `/api/vendas` | Não recriar | **R1** |
| Motor venda MULTIEMPRESA | `backend/motores/muv/AtendimentoMultiempresaService.js` | `criarAtendimento`, `materializarAtendimento` | checkout + atendimentos/* | MUV | Via `/api/vendas` modo MUV | Sim | Oficial MUV | Manter ciclo reserva→pagamento→materializar | **R1** |
| Pré-cálculo F×NF | `frontend/pdv/js/pdv.js` | `precalcularDistribuicaoFiscalVenda` | `POST /api/vendas/pre-calcular-distribuicao` | `VendaPagamentoService.preCalcularDistribuicao` | Sim | Não | Ausente Universal EMPRESA_UNICA | Conectar se exigir preview fiscal | **R4** |
| Pagamento não-fiscal 2ª etapa | `frontend/pdv/js/pdv.js` | `registrarPagamentoNaoFiscal` | `GET/POST /api/vendas/:id/pagamento-nao-fiscal` | `VendaPagamentoService` | Sim | Não | Ausente Universal | Avaliar paridade fiscal | **R4** |
| Emissão fiscal pós-venda | `frontend/pdv/js/pdv.js` | `emitirNFCeVenda` | `POST /api/fiscal/emitir/venda/:id` | `services/fiscal/emissor` | Sim | Sim (`pos-pagamento:fiscalizar`) | Dois caminhos | Universal MUV: fiscalizar atendimento | **R2** |
| Verificar caixa aberto | `pdv.js` / `pdv-universal.js` | `verificarStatusCaixa` / `atualizarStatusCaixa` | `GET /api/caixa/aberto` | `FechamentoCaixaResumoService` | Sim | Sim | Compartilhado | Manter | **R1** |
| Bloqueio venda caixa fechado | `backend/middleware/validarCaixaAberto.js` | `validarCaixaSeOrigemPdv` | checkout + vendas POST | middleware | Sim | Sim | Compartilhado | Manter | **R1** |
| Abrir caixa | `frontend/pdv/js/caixa.js` | `abrirCaixa` | `POST /api/caixa/abrir` | inline + `equipamentos-integracao` | Sim (página caixa) | Não | Universal só consulta | Reutilizar API + UI ERP/caixa legado | **R4** |
| Fechar caixa | `frontend/pdv/js/caixa.js` | `fecharCaixa` | `POST /api/caixa/fechar` | `FechamentoCaixaCupomService` | Sim | Não (botão disabled) | Backend pronto | Conectar UI Universal | **R4** |
| Sangria / suprimento | `frontend/pdv/js/caixa.js` | `registrarSangria`, `registrarSuprimento` | `POST /api/caixa/sangria`, `/suprimento` | inline SQL | Sim | Não | Backend pronto | Conectar UI | **R4** |
| Pagamento dinheiro | `frontend/pdv/js/pdv.js` | `selecionarPagamentoPDV('dinheiro')` | via `POST /api/vendas` ou checkout | `VendaPagamentoService` | Sim | Sim (`#pdvu-forma`) | Duplicado fluxo | Universal OK | **R1** |
| Pagamento débito/crédito TEF | `frontend/pdv/js/pdv.js` | `processarPagamentoTEF` | `POST /api/tef/pagar` | `services/tef` → `TefManager` | Sim | Sim (`pdv-universal-tef.js`) | Mesma API | Universal EMPRESA_UNICA OK | **R1** |
| Pagamento PIX direto | `frontend/pdv/js/pdv.js` | `iniciarPixAutomaticoPDV` | `POST /api/pix/criar-cobranca`, `GET /api/pix/status/:txid` | `pixService` | Sim | Sim (`pdv-universal-pix.js`) | Mesma API | Universal EMPRESA_UNICA OK | **R1** |
| PIX via TEF | `frontend/shared/js/tefFluxoPagamento.js` | `ehPagamentoPixTef`, `resolverFluxoPagamentoFiscal` | `POST /api/tef/pagar` (tipo pix_tef) | TefManager | Sim | Não | Universal não usa fluxo compartilhado | Conectar `tefFluxoPagamento.js` | **R4** |
| Pagamento misto | `frontend/pdv/js/pdv.js` | `abrirPagamentoMisto`, `processarPagamentosMistosTEF` | vendas + tef/pix | VendaPagamentoService + TEF | Sim | Não (modal multiempresa sem TEF/PIX) | Ausente Universal balcão | Implementar futuro | **R7** |
| Pagamento a prazo | `frontend/pdv/js/pdv.js` | `mostrarModalClientePrazo` | via `POST /api/vendas` | VendaPagamentoService | Sim | Não | Ausente Universal | Criar futuro | **R7** |
| Pagamento unificado multiempresa | `pdv-universal-pagamento.js` | `confirmarPagamento` | `POST /api/pdv-universal/atendimentos/:id/pagamento` | `AtendimentoMultiempresaService` | Não | Sim | Exclusivo Universal | Manter | **R1** |
| Reserva estoque atendimento | `pdv-universal-pagamento.js` | `reservarAtendimento` | `POST .../reservar` | MUV | Não | Sim | Exclusivo Universal | Manter | **R1** |
| Fluxo TEF compartilhado | `frontend/shared/js/tefFluxoPagamento.js` | `TefFluxoPagamento.*` | `GET /api/tef/fluxo-pdv` | `tefFluxoPagamento` + config | Sim (`pdv.js`) | **Não importado** | Universal duplica tipos em `pdv-universal-tef.js` | Importar módulo compartilhado | **R3** |
| TEF pagar | `backend/rotas/tef.js` | router POST `/pagar` | `POST /api/tef/pagar` | `TefManager.autorizar` | Sim | Sim | Compartilhado | Manter | **R1** |
| TEF cancelar | `backend/rotas/tef.js` | POST `/cancelar` | `POST /api/tef/cancelar` | `TefManager.cancelar` | Sim | Não | Universal não cancela | Conectar no cancel venda | **R4** |
| TEF fluxo-pdv (flags) | `backend/rotas/tef.js` | GET `/fluxo-pdv` | `GET /api/tef/fluxo-pdv` | `tefConfigService` | Sim | URL exportada, **não chamada** | Desconectado Universal | Conectar antes de PIX-TEF | **R4** |
| Comprovante TEF USB | `backend/rotas/impressao.js` | POST `/tef` | `POST /api/impressao/tef` | escpos USB | Sim | Não | Legado only | Opcional Universal | **R4** |
| TEF idempotência | `backend/services/tef/TefManager.js` | `idempotency_key` | tef/pagar body | `tefRepository` | Sim | Sim (Universal envia key) | Compartilhado | Manter | **R1** |
| PIX config | `backend/rotas/pix.js` | GET `/config` | `GET /api/pix/config` | `pixService` | Sim | Não | Universal usa contexto | Opcional | **R2** |
| Venda entrega (criar) | `frontend/pdv/js/pdv-venda-entrega.js` | `confirmarVendaEntrega` | `POST /api/vendas` (`tipo_venda: ENTREGA`) | `CriarVendaEntregaService` | Sim | Não | Backend existe | Conectar UI Universal | **R4** |
| Dashboard entregas | `frontend/pdv/js/entregas.js` | `carregarDashboard` | `GET /api/vendas/entregas/dashboard` | `EntregaService` | Sim | Não | Backend existe | Conectar ou manter legado | **R4** |
| Iniciar entrega | `frontend/pdv/js/entregas.js` | `bindAcoesPedidos` | `POST /api/vendas/entregas/:id/iniciar` | `EntregaService` | Sim | Não | Backend existe | Conectar | **R4** |
| Prestação entrega | `frontend/pdv/js/pdv-prestacao-entrega.js` | `finalizarPrestacao` | `POST /api/vendas/:id/prestacao` | `EntregaService` | Sim | Não | Backend completo | Conectar widget/drawer | **R4** |
| Cancelar entrega | `pdv-prestacao-entrega.js` | `cancelarEntrega` | `DELETE /api/vendas/:id/entrega` | `EntregaService` | Sim | Não | Backend existe | Conectar | **R4** |
| Etiqueta balança interpretar | `frontend/pdv/js/pdv.js` | `interpretarEtiquetaViaMotorEquipamentos` | `POST /api/equipamentos/etiquetas/interpretar` | `LayoutEtiquetaService` | Sim | **Não** | Backend pronto; Universal qty=1 | Conectar identificação → peso | **R4** |
| Leitura balança contínua | `backend/rotas/equipamentos.js` | `/weight/read`, drivers Toledo | várias | `motores/equipamentos/` | Não no fluxo PDV venda direta | Não | Existe motor, não ligado Universal | Sprint futura balança | **R4** |
| Pesagem manual UI | `frontend/pdv-universal/pdv-universal.js` | `abrirPesagemManual` | — | `PDVUniversalCart` | Parcial (modal qty legado) | Sim (05.29) | Universal ahead | Manter | **R1** |
| Peso etiqueta → carrinho | `pdv-universal-identificacao.js` | `quantidadeOperacionalPadrao` | identificar meta | — | Sim (legado aplica peso) | **Força qty=1** | Desconectado | Conectar meta.peso | **R4** |
| Comprovante não-fiscal browser | `frontend/shared/js/fiscalImpressao.js` | `imprimirCupomNaoFiscal` | fiscal emit + print local | emissor | Sim | Não direto | Legado | Avaliar paridade | **R2** |
| Comprovante unificado HTML | `pdv-universal-pos-pagamento.js` | `obterComprovanteHtml` | `GET /api/pdv-universal/atendimentos/:id/comprovante` | `ComprovanteUnificadoAtendimentoService` | Não | Sim | Universal MUV | Manter | **R1** |
| Impressão MUV browser | `muv-comprovante-client.js` | `prepararImpressaoBrowser` | `POST /api/atendimentos/:id/imprimir` | `ComprovantePrintService` → `BrowserPrintAdapter` | Não | Sim | Compartilhado MUV | Manter | **R1** |
| Impressão térmica MUV | `backend/motores/muv/impressao/ThermalPrintAdapter.js` | via PrintAdapter | atendimentos/imprimir | `ComprovantePrintService` | Não confirmado PDV | Backend pronto | Desconectado PDV | Conectar destino THERMAL | **R4** |
| DANFE/NFC-e impressão | `fiscalImpressao.js` | `imprimirDANFEFiscal` | `POST /api/fiscal/emitir/venda/:id` | emissor | Sim | Via fiscalizar MUV | Dois caminhos | Unificar estratégia | **R2** |
| Cupom fechamento caixa | `frontend/pdv/js/caixa.js` | `imprimirCupomFechamentoCaixa` | resposta `POST /api/caixa/fechar` | `FechamentoCaixaCupomService` | Sim | Não | HTML local print | Conectar quando UI caixa | **R4** |

---

## Resumo quantitativo da matriz

| Classificação | Qtd (recursos mapeados) |
|---------------|-------------------------|
| R1 — Reutilizar diretamente | 22 |
| R2 — Reutilizar com adaptação | 5 |
| R3 — Extrair para compartilhado | 1 |
| R4 — Conectar ao Universal | 24 |
| R5 — Duplicado / unificar | 6 |
| R6 — Obsoleto | 0 confirmados neste escopo |
| R7 — Não existe / criar futuro | 2 |

**Total de recursos analisados:** 60 linhas na matriz (domínios A–K).

---

## Arquivos efetivamente analisados

### Frontend legado
- `frontend/pdv/index.html`
- `frontend/pdv/js/pdv.js` (rastreamento parcial ~6911 linhas)
- `frontend/pdv/js/caixa.js`
- `frontend/pdv/js/entregas.js`
- `frontend/pdv/js/pdv-prestacao-entrega.js`
- `frontend/pdv/js/pdv-venda-entrega.js`
- `frontend/shared/js/tefFluxoPagamento.js`
- Dependências diretas referenciadas: `fiscalImpressao.js`, `motor-preco-atacado.js`, `pdvBuscaProduto.js`, `muv-comprovante-client.js`

### Frontend Universal
- `frontend/pdv-universal/*` (13 arquivos JS + HTML + CSS)

### Backend (rotas + 1–2 níveis service)
- `backend/rotas/pdv-universal.js`
- `backend/rotas/vendas.js`
- `backend/rotas/entregas.js`
- `backend/rotas/caixa.js`
- `backend/rotas/tef.js`
- `backend/rotas/pix.js`
- `backend/rotas/equipamentos.js`
- `backend/rotas/impressao.js`
- `backend/middleware/validarCaixaAberto.js`
- `backend/services/pdv-universal/*`, `backend/services/vendas/VendaPagamentoService.js`
- `backend/motores/muv/*` (atendimento, comprovante, impressão)
- `backend/services/tef/*`, `backend/services/pix/*`
- `backend/motores/equipamentos/services/LayoutEtiquetaService.js`

### Fora do escopo mas referenciado pelo Universal
- `backend/rotas/atendimentos.js` (`POST /api/atendimentos/:id/imprimir`)

---

## Itens NÃO CONFIRMADOS NO CÓDIGO

| Item | Rastreado até |
|------|----------------|
| Balança contínua no fluxo de venda PDV legado | `equipamentos.js` tem endpoints; **pdv.js não chama `/weight/read` na venda** |
| Universal impressão térmica direta | Backend `ThermalPrintAdapter` existe; frontend Universal só envia `destino:'BROWSER'` |
| ERP `backend/rotas/caixas.js` (multi-caixa) | Montado em `/api/caixas`; **nenhum PDV frontend chama** |
