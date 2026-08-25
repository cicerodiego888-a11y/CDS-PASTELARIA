# MAPA REAL DE EXECUÇÃO — PDV LEGADO

**Sprint:** 05.19.1  
**Fonte:** código confirmado. Sem implementação. Sem remoção.

## Rota HTTP

| Item | Valor confirmado |
|------|------------------|
| Rotas | `GET /pdv` e `GET /pdv/` |
| Arquivo | `backend/server.js` (~195–200) |
| Auth | `verificarToken` |
| Licença | `configService.recursoHabilitado('pdv')` |
| HTML servido | `frontend/pdv/index.html` |
| Menu ERP | `frontend/erp/index.html` → `#nav-abrir-pdv-legado` → `href="/pdv"` |

## HTML

| Papel | Arquivo |
|-------|---------|
| Shell + sidebar | `frontend/pdv/index.html` |
| Tela de venda (injetada em `#page-content`) | `frontend/pdv/pages/pdv.html` |
| Outras telas | geradas em JS (`caixa.js`, `clientes.js`, `vendas.js`, `entregas.js`) |

## CSS

| Arquivo | Papel |
|---------|--------|
| `/css/style.css` | Base CDS |
| `/css/pdv.css` | Layout operacional (header, busca, tabela, resumo, atalhos) |
| `/css/pdv-themes.css` | Temas / F11 |
| `/shared/css/muv-comprovante.css` | Comprovante compartilhado |

## JS — cadeia de carga (`index.html`)

1. `brand-service.js`, `estacaoHostname.js`, `validarMotivo.js`, `modalDevolucaoVenda.js`
2. `access-control.js`, `pdv-acesso-oficial.js`, `caixaPermissoes.js`
3. `cds-empresa-contexto.js` (header `X-Empresa-Id` se seletor ativo)
4. `core.js`, `cds-nomenclatura.js`, `configuracaoRede.js`
5. `modoFiscalHelpers.js`, `fiscalImpressao.js`
6. `muv-comprovante-client.js`, `muv-comprovante-modal.js`
7. `vendasHistoricoUi.js`, `pdvBuscaProduto.js`, `motor-preco-atacado.js`, `tefFluxoPagamento.js`
8. `pdv-theme-manager.js`, `pdv-footer-widgets.js`
9. `pdv-venda-entrega.js`, `pdv-prestacao-entrega.js`
10. **`pdv.js`** (motor de tela de venda)
11. `pdv-appearance-panel.js`
12. `nomeTerminalPdv.js`, `caixa.js`, `clientes.js`, `vendas.js`, `entregas.js`
13. `AgentSDK.js`, `cds-copiloto-widget.js`, **`app.js`** (roteador de páginas)

## Páginas internas (`frontend/pdv/js/app.js`)

| `data-page` | Loader | Conteúdo |
|-------------|--------|----------|
| `pdv` | `pdv.html` + `loadPDV()` | Frente de caixa |
| `consulta` | mesmo HTML + `abrirConsultaProdutosPDV()` | Consulta de preço (F1) |
| `entregas` | `loadEntregas()` | Fila / dashboard entregas |
| `clientes` | `loadClientes()` | Cadastro/consulta clientes |
| `caixa` | `loadCaixa()` | Abrir/fechar/sangria/suprimento |
| `reimpressao` | `loadVendas()` | Histórico / cupom |
| `configuracao-rede` | modal | Super-admin |
| `nome-terminal-pdv` | modal | Super-admin |

## Eventos / atalhos (tela de venda)

Confirmados em `pdv.js` `bindEventosPDV` + listener global + `pdv-appearance-panel.js`:

| Tecla | Ação real no código |
|-------|---------------------|
| F1 | `abrirConsultaProdutosPDV()` (modal consulta) |
| F2 | Foco em `#buscaProdutoPdv` (listener extra; **não** está no rodapé) |
| F4 | Foco quantidade do último item |
| F7 | `abrirFechamentoCaixa()` — **não** é pesagem |
| F8 | Foco `#descontoPdv` com autorização supervisor |
| F9 | Clique `#btnVendaEntregaPdv` se módulo `vendasEntrega` ativo |
| F10 | Clique `#btnFinalizarVendaPdv` (balcão) |
| F11 | Painel de aparência |
| ESC | Fecha busca se aberta; senão `cancelarVendaAtual()` / `#btnCancelarVendaPdv` |
| ENTER (busca) | `PdvBuscaProduto` → identificar / adicionar |

**F12:** comentários em `pdv.js` (“modo fiscal usado pelo F12”). **Não há `keydown` F12 no PDV.** O modo fiscal vem de `modoFiscalAtivoSistema()` (`modoFiscalHelpers.js`), não de atalho local.

## APIs usadas pelo legado (venda e satélites)

| API | Uso |
|-----|-----|
| `GET /api/produtos` | Catálogo / modo_fiscal |
| `GET /api/produtos/identificar` | MIP / código / PLU / barras |
| `GET /api/produtos/consulta-pdv/buscar` | F1 e autocomplete |
| `GET /api/produtos/:id/promocao-ativa` | Promoção |
| `GET /api/produtos/:id/atacado` | Faixas atacado |
| `POST /api/equipamentos/etiquetas/interpretar` | Etiqueta balança (peso/valor) |
| `GET /api/categorias?tipo=produto` | Filtro consulta |
| `GET /api/caixa/aberto` | Status caixa |
| `GET /api/caixa/saldo-inicial-sugerido` | Abrir caixa |
| `POST /api/caixa/abrir` `sangria` `suprimento` `fechar` | Operações caixa |
| `GET /api/caixa/por-data` `GET /api/caixa/fechamento/:id` | Conferência |
| `POST /api/caixa/:id/reimprimir` | Reimpressão fechamento |
| `GET /api/clientes` `GET /api/clientes/buscar` | Cliente / prazo / entrega |
| `POST /api/vendas` | **Finalização oficial da venda (balcão e entrega)** |
| `POST /api/vendas/pre-calcular-distribuicao` | Split fiscal / não fiscal |
| `POST /api/vendas/:id/pagamento-nao-fiscal` | 2ª etapa não fiscal |
| `POST /api/fiscal/emitir/venda/:id` | NFC-e após venda |
| `GET /api/tef/fluxo-pdv` `POST /api/tef/pagar` `POST /api/tef/cancelar` | TEF |
| `POST /api/impressao/tef` | Comprovante TEF |
| `GET /api/tef/venda/:id/resumo` | Resumo TEF |
| `GET /api/pix/config` `POST /api/pix/criar-cobranca` `GET /api/pix/status/:txid` | PIX não TEF |
| `POST /api/auth/supervisor/authorize` | Desconto / caixa |
| `GET /api/configuracoes-avancadas/confirmacao-fiscal` | Confirmação fiscal |
| `GET/POST /api/terminais/auto` | Terminal / hostname |
| `GET /api/vendas/entregas*` | Fila, dashboard, iniciar |
| `PATCH/POST /api/vendas/:id/entrega` | Cancelar/atualizar entrega |
| ViaCEP (externo) | CEP no modal entrega |

## Motor e persistência

```
ROTA /pdv
  → frontend/pdv/index.html
  → pages/pdv.html + pdv.js
  → eventos (F10 / botão)
  → POST /api/vendas
  → rotas vendas (legado)
  → VendaApplicationService
  → persistência: vendas, itens, pagamentos, estoque, financeiro
  → opcional POST /api/fiscal/emitir/venda/:id
```

**Confirmação:** o PDV legado **finaliza a venda em `POST /api/vendas`**. Entrega (`pdv-venda-entrega.js` linha ~528) também usa `POST /api/vendas`.

Não chama `/api/pdv-universal/*`.

## Integrações

- **Caixa:** `validarCaixa` implícito nas rotas de venda + UI `/caixa/*`.
- **TEF:** `tefFluxoPagamento.js` + `/api/tef/*`.
- **Fiscal:** modo sistema + emissão por venda.
- **Equipamentos:** interpretação de etiqueta (não leitura contínua de peso no atalho F7).
- **Terminal:** hostname / nome PDV.
- **Multiempresa (parcial):** `CdsEmpresaContexto` anexa `X-Empresa-Id` em algumas chamadas. Carrinho e persistência foram desenhados para **empresa única / contexto de header**, não para atendimento MUV.
- **Comprovante MUV:** scripts compartilhados carregados; `notificarAtendimentoMuvSePresente` se a resposta de venda trouxer atendimento.

## Estado próprio

- Array `carrinho` em memória em `pdv.js`.
- Totais (subtotal, desconto, acréscimo, atacado) calculados no **frontend**, com pré-cálculo oficial de distribuição via backend.
- Sem atendimento MUV como entidade principal.
