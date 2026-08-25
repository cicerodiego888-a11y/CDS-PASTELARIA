# LISTA DE CÓDIGO OBSOLETO / RISCO — PDV LEGADO

**Sprint:** 05.19.1. **Nenhum arquivo deletado.** Inventário para fases futuras (8–9).

## CÓDIGO MORTO / enganoso

| Item | Onde | Por quê |
|------|------|---------|
| Comentários “F12 ativo / desativado” | `pdv.js` ~1798, ~4269 | Não há `keydown` F12 no PDV. Modo fiscal é `modoFiscalAtivoSistema()`. |
| Listener F7 duplicado | `pdv.js` `bindEventosPDV` **e** `document.addEventListener` ~6787 | Mesma ação (`abrirFechamentoCaixa`) duas vezes. |
| ESC duplicado | Mesmos dois listeners | Risco de clique duplo em cancelar. |
| Chip “F7 Fechar Caixa” vs expectativa “F7 balança” | `pdv.html` footer | Documentação histórica/produto divergia do código. |

## ATIVO MAS LEGADO (não apagar agora)

Tudo abaixo **ainda é operação real**. Só vira candidato a arquivo após paridade no Universal + regressão.

- `frontend/pdv/js/pdv.js` (~6900 linhas) — monolito de venda
- `frontend/pdv/js/caixa.js`, `entregas.js`, `pdv-venda-entrega.js`, `pdv-prestacao-entrega.js`
- `frontend/pdv/js/vendas.js`, `clientes.js`, `app.js`
- `frontend/pdv/pages/pdv.html`
- `frontend/css/pdv.css`, `pdv-themes.css`
- Chamada browser `POST /api/vendas` a partir do PDV
- `calcularDistribuicaoFiscalLocal` — fallback se pré-cálculo falhar (espelho do backend)
- `GET /api/produtos/:id/atacado` síncrono (`async: false`) — padrão antigo, ainda usado

## OBSOLETO para o PDV único (não portar)

| Item | Motivo |
|------|--------|
| Arquitetura “carrinho + POST /api/vendas como única porta” | Porta oficial futura: `/api/pdv-universal/*` |
| Cálculo de valor fiscal líquido no frontend como fonte | Backend / MUV já são oficiais |
| `X-Empresa-Id` ad hoc sem `resolverModoOperacaoVendaAtivo` | Multiempresa oficial é o Universal |
| Restaurar F7 = peso | Nunca foi o binding real |
| Criar terceiro `pdv-express` / HTML híbrido | Proibido |

## NÃO UTILIZADO no caminho Universal

Scripts do legado **não** entram no `index.html` do Universal: TEF, caixa, entregas, temas, copiloto, `pdvBuscaProduto`.

## RISCO DE REGRESSÃO se “limpar” cedo

- Remover `/pdv` ou menu “PDV legado”
- Apagar `pdv.js` antes de: entrega, caixa, TEF, PIX, prazo, etiqueta, atacado, F1 consulta
- Alterar `POST /api/vendas` “porque o Universal não usa no browser” — ERP/legado/entrega ainda usam
- Desligar `/api/tef/*` ou `/api/pix/*` sem wiring no Universal

## Classificação resumida do shell legado

| Bloco | STATUS |
|-------|--------|
| `pdv.html` layout | ATIVO E APROVEITÁVEL (referência visual) |
| `pdv.js` lógica | ATIVO MAS LEGADO |
| Tema F11 | ATIVO E APROVEITÁVEL (opcional) |
| Entregas | ATIVO MAS LEGADO / A MIGRAR |
| Caixa | ATIVO MAS LEGADO / A MIGRAR |
| Comentário F12 | CÓDIGO MORTO |
| Dual keydown F7/ESC | ATIVO MAS LEGADO (higiene futura) |
