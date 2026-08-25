# MATRIZ FUNCIONAL — PDV LEGADO vs PDV UNIVERSAL

**Sprint:** 05.19.1. Status obrigatório por funcionalidade.

Legenda de STATUS:

- **ATIVO E APROVEITÁVEL** — UX/regra madura; reusar ideia/visual, não o JS monolítico
- **ATIVO MAS LEGADO** — funciona no `/pdv`; acoplado a `pdv.js` / `POST /api/vendas`
- **JÁ SUBSTITUÍDO PELO UNIVERSAL** — Universal já é o caminho oficial
- **A MIGRAR** — Universal ainda não tem equivalente operacional
- **OBSOLETO** — não deve ir para o único PDV
- **CÓDIGO MORTO** — comentário/código sem binding
- **NÃO UTILIZADO** — carregado ou citado sem fluxo
- **RISCO DE REGRESSÃO** — unificar sem equivalência quebra operação

| Funcionalidade | Legado | Universal | STATUS | Notas |
|----------------|--------|-----------|--------|-------|
| Rota visível | `/pdv` | `/pdv-universal/` | JÁ SUBSTITUÍDO PELO UNIVERSAL (oficial) + ATIVO MAS LEGADO (rota ainda viva) | Não desativar nesta sprint |
| Shell operacional (sidebar + páginas) | Sim | Não (tela única) | ATIVO E APROVEITÁVEL (padrão visual) / A MIGRAR (páginas satélite) | Universal não tem sidebar |
| Header marca / operador / data-hora | Sim | Marca + operador; sem relógio | ATIVO E APROVEITÁVEL | Visual legado melhor |
| Status / fechar caixa no header | Sim (F7) | Não | A MIGRAR + RISCO DE REGRESSÃO | Caixa Universal só valida no checkout |
| Calculadora flutuante | Sim | Não | ATIVO E APROVEITÁVEL | Só UI |
| Aparência F11 / temas | Sim | Não | ATIVO E APROVEITÁVEL | Não migrar tema como arquitetura |
| Menu hamburger fullscreen | Sim | Não | ATIVO E APROVEITÁVEL | |
| Empresa no header | Seletor `CdsEmpresaContexto` | Modo + empresa oficial | JÁ SUBSTITUÍDO PELO UNIVERSAL | Não copiar empresa fixa |
| Busca código / nome / barras | `PdvBuscaProduto` + identificar | `consulta-pdv/buscar` | ATIVO MAS LEGADO / A MIGRAR (paridade PLU/identificar) | Universal não chama `/produtos/identificar` |
| PLU / MIP | `/produtos/identificar` | Só consulta texto | A MIGRAR + RISCO DE REGRESSÃO | |
| Leitor + ENTER | Sim | Busca texto | A MIGRAR | |
| Autocomplete dropdown | Sim | Lista `#pdvu-resultados` | ATIVO E APROVEITÁVEL | |
| Foco automático busca | Sim | F1 foca input | ATIVO E APROVEITÁVEL | |
| Consulta F1 modal (preço) | Sim | F1 = foco (não modal) | ATIVO MAS LEGADO / A MIGRAR | |
| Quantidade F4 | Sim | Não | A MIGRAR | |
| Tabela itens (UN, desc %, desc R$) | Sim | Lista simples | ATIVO E APROVEITÁVEL (layout) | Cálculo item no legado |
| Remoção / limpar venda | Sim | Recriar atendimento | ATIVO E APROVEITÁVEL | |
| Estoque fiscal vs não fiscal na adição | `validarEstoqueVenda` | Disponibilidade por empresa | ATIVO MAS LEGADO / JÁ SUBSTITUÍDO (saldo empresa) | Regras diferentes |
| Etiqueta peso/valor (MIB) | `/equipamentos/etiquetas/interpretar` | Não | A MIGRAR + RISCO DE REGRESSÃO | Reusar Motor Equipamentos, não duplicar |
| Peso médio / fracionado | `peso_medio_unidade` | Não | A MIGRAR | |
| Balança contínua / F7 peso | **Não existe** (F7 = caixa) | Não | NÃO UTILIZADO | Sprint assumia F7 peso; código desmente |
| Promoção / atacado | APIs + motor-preco-atacado | Não na UI | A MIGRAR + RISCO DE REGRESSÃO | |
| Subtotal / desconto / acréscimo resumo | Inputs reais | Só total itens | A MIGRAR | |
| Cálculo totais | Frontend + `pre-calcular-distribuicao` | Backend checkout/MUV | ATIVO MAS LEGADO | Universal: não copiar calc local |
| Tipo venda Balcão | Default F10 | Atendimento PDV | JÁ SUBSTITUÍDO PELO UNIVERSAL | |
| Tipo venda Entrega F9 | `POST /api/vendas` + módulo entregas | Ausente | A MIGRAR + RISCO DE REGRESSÃO | Não criar 3º PDV; absorver depois |
| Fila entregas / prestação | Páginas + widgets | Ausente | A MIGRAR | |
| Finalizar F10 | Modal pagamentos | FINALIZAR ATENDIMENTO | ATIVO MAS LEGADO / JÁ SUBSTITUÍDO (pipeline) | |
| API finalizar | **`POST /api/vendas`** | **`POST /api/pdv-universal/checkout`** | JÁ SUBSTITUÍDO PELO UNIVERSAL | Não alterar `/api/vendas` |
| Múltiplas formas | Sim (misto + TEF) | Modal linhas | A MIGRAR (paridade TEF/PIX/prazo) | |
| Dinheiro + troco | UI `#pdvDinheiroBox` | Diferença no modal | A MIGRAR (UX troco) | |
| PIX (API pix) | `/api/pix/*` | Forma PIX sem cobrança | A MIGRAR + RISCO DE REGRESSÃO | |
| Débito / crédito TEF | `/api/tef/*` | Select sem TEF | A MIGRAR + RISCO DE REGRESSÃO | Critério 14 |
| Prazo / cliente / parcelas | UI + clientes | Não | A MIGRAR | |
| Cancelar ESC | Limpa carrinho | Fecha modal | ATIVO MAS LEGADO | Universal: cancelar atendimento é botão dedicado |
| Reserva estoque pré-pago | Implícita na venda | Explícita MULTIEMPRESA | JÁ SUBSTITUÍDO PELO UNIVERSAL | |
| Materialização | Imediata na venda | Passo explícito ME | JÁ SUBSTITUÍDO PELO UNIVERSAL | |
| Fiscalização | `/fiscal/emitir/venda/:id` | `/fiscalizar` MUV | JÁ SUBSTITUÍDO PELO UNIVERSAL (ME) | EU: VAS interno |
| Comprovante unificado | Scripts MUV opcionais | Modal oficial | JÁ SUBSTITUÍDO PELO UNIVERSAL | |
| Impressão cupom legado | Fluxo pdv.js | Preview comprovante | ATIVO MAS LEGADO | |
| Abrir/fechar/sangria/suprimento | Página caixa | Só middleware checkout | A MIGRAR + RISCO DE REGRESSÃO | |
| Conferência / reimpressão caixa | Sim | Não | A MIGRAR | |
| Reimpressão cupom / histórico | `vendas.js` | Não | A MIGRAR | |
| Clientes no PDV | Página | Não | A MIGRAR (se operação exigir) | |
| Config rede / nome terminal | Modais | Não | ATIVO MAS LEGADO | Pode permanecer ERP |
| Copiloto / AgentSDK | Carregado | Não | NÃO UTILIZADO no Universal | |
| Checkout EMPRESA_UNICA | VAS via `/api/vendas` | VAS via adaptador | JÁ SUBSTITUÍDO PELO UNIVERSAL | |
| Checkout MULTIEMPRESA | Não oficial | MUV | JÁ SUBSTITUÍDO PELO UNIVERSAL | Não migrar lógica empresa-fixa |
| Comentário F12 | Sem keydown | — | CÓDIGO MORTO | Modo fiscal é sistema |
| F2 foco busca | Listener extra | — | ATIVO MAS LEGADO | Conflito potencial com ERP |
| Link “PDV legado” no Universal | — | `<a href="/pdv">` | ATIVO MAS LEGADO | Remover só na Fase 8 documental |
