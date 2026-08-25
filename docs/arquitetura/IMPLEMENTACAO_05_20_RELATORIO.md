# IMPLEMENTAÇÃO 05.20 — FUNDAÇÃO VISUAL DO PDV ÚNICO

**Tipo:** camada visual do PDV Universal  
**Não alterado:** MUV, VAS, `POST /api/vendas`, `pdv.js`, rota `/pdv`, fiscal, estoque, financeiro.

## Confirmação explícita

**PDV Universal permanece o único alvo arquitetural.  
PDV legado ainda permanece temporariamente por compatibilidade.**

## 1. Arquivos alterados

| Arquivo | Papel |
|---------|--------|
| `frontend/pdv-universal/index.html` | Shell operacional (header, busca, tabela, resumo, drawer, calc, chips) |
| `frontend/pdv-universal/pdv-universal.css` | Grid ~75/25, densidade operacional, total, atalhos |
| `frontend/pdv-universal/pdv-universal.js` | Relógio, caixa via `/api/caixa/aberto`, ESC/F1/F10, calc, pintar tabela/resumo |
| `tests/pdv-universal/fundacao-visual-05-20.test.js` | Aceite da sprint |
| `docs/arquitetura/IMPLEMENTACAO_05_20_RELATORIO.md` | Este relatório |

## 2. Mapa dos componentes migrados visualmente

| Componente | Origem visual (legado) | Destino Universal | Binding |
|------------|------------------------|-------------------|---------|
| Header hamburger + marca | `pdv.html` topo | `#pdvu-btn-menu` + marca | Drawer local |
| Modo / empresa | — (Universal) | centro do header | Contexto oficial |
| Operador + relógio | legado | `#pdvu-operador` / `#pdvu-data-hora` | Timer 1s |
| Status caixa | legado | `#pdvu-status-caixa` | `GET /api/caixa/aberto` (sem fake) |
| Fechar caixa | legado | botão **disabled** | Sprint futura |
| Busca label + input + BUSCAR | legado | `#pdvu-busca-*` | `consulta-pdv/buscar` |
| Tabela itens 7 colunas | legado | `.pdvu-tabela` | `PDVUniversalCart` |
| Estado vazio discreto | legado | “Nenhum item no carrinho” | — |
| Resumo + TOTAL | legado | painel lateral | Totais do cart; desc/acréscimo `—` |
| Finalizar (F10) | legado visual | `#pdvu-finalizar` | `POST /api/pdv-universal/checkout` |
| Cancelar (ESC) | legado visual | `#pdvu-cancelar` + ESC contextual | Sem destruir pagamento |
| Chips atalhos | legado | rodapé | Só F1 / F10 / ESC |
| Calculadora | legado | widget `#pdvu-calc` | Isolada |
| Menu | sidebar legado | drawer compacto | ERP + selecionar empresa |

**Não copiado:** `pdv.js`, TEF, PIX, entrega, desconto motor, PLU/identificar.

## 3. APIs chamadas (Universal nesta sprint)

| API | Uso |
|-----|-----|
| `GET /api/pdv-universal/contexto` | Contexto / modo / empresa |
| `PUT /api/pdv-universal/contexto/empresa` | Seleção empresa |
| `GET /api/produtos/consulta-pdv/buscar` | Busca |
| `GET /api/pdv-universal/produtos/:id/disponibilidade` | Estoque por empresa |
| `POST /api/pdv-universal/checkout` | Finalizar (oficial) |
| `GET /api/caixa/aberto` | Status real (VERIFICANDO → ABERTO/FECHADO/INDISPONÍVEL) |
| Demais MUV pós-checkout | Reserva / pagamento / materializar / fiscalizar / comprovante (já existentes) |

**Não chamado:** `POST /api/vendas`.

## 4. Atalhos implementados (com comportamento real)

| Atalho | Ação |
|--------|------|
| F1 | Foco `#pdvu-busca-input` |
| F10 | Dispara finalizar **somente** se botão habilitado e checkout permitido |
| ESC | Fecha modal → fecha drawer → preserva se pagamento/atendimento → senão limpa carrinho |
| ENTER (busca) | Executa busca oficial |

## 5. Atalhos apenas visuais — proibidos nesta sprint

Não exibidos / não restaurados: F4, F7 (peso ou caixa ativo), F8, F9, F11, F12.

## 6–7. Testes executados

| Suite | Resultado |
|-------|-----------|
| `fundacao-visual-05-20` | **18/18** |
| `tela-principal-05-03` | 15/15 |
| `ativacao-visual-acesso-05-12` | 19/19 |
| `auditoria-visual-correcao-05-13` | 29/29 |
| `estabilizacao-operacional-05-10` | 20/20 |
| `checkout-empresa-unica-05-05` | 18/18 |
| `checkout-multiempresa-05-06` | 25/25 |
| `carrinho-universal-05-04` | 25/25 |
| `pagamento-unificado-muv-05-07` | 25/25 |
| `materializacao-fiscal-comprovante-05-08` | 19/19 |
| `fundacao-pdv-universal-05-01` | 15/15 |
| `contexto-operacional-05-02` | 25/25 |
| `auditoria-geral-fluxo-real-05-16` | 3/3 |
| `correcao-navegacao-e-gestao-multiempresa-05-14` | 24/24 |

**Total regressão listada:** todas verdes. Nenhum motor/MUV/VAS alterado.

## 8. Evidência visual

Abrir `/pdv-universal/` no Electron/browser autenticado e conferir:

- header 3 zonas
- busca operacional
- tabela + resumo lateral
- chips F1/F10/ESC
- sem link “PDV legado” no layout

## 9. Pendências para paridade total (sprints futuras)

TEF, PIX cobrança, entrega, prazo/clientes, desconto/atacado, PLU/`identificar`, balança/etiqueta, UI caixa (abrir/fechar/sangria), impressão/reimpressão, histórico.

## 10. Estado

**ESTADO A (implementação visual + testes Node).**  
Validação visual assistida no ambiente real = operador no Electron.
