# PDV-MULTIEMPRESA-12 — Correção visual dos erros de capacidade

**Data:** 2026-10-26  
**Módulo:** PDV oficial `/pdv`  
**Estado final:** **CONCLUÍDA**

## 1. Problema

O banner `#pdv-selecao-empresa-info` era inserido **dentro da `<table>`** (irmão do `tbody#tabelaItensVendaPdv`) com o texto completo do HTTP 409 (`Gargalos: produto… ESTOQUE_INSUFICIENTE…`). Isso deformava a lista de itens.

## 2. Correção (somente UI)

| Mudança | Detalhe |
|---|---|
| Ancoragem | Banner sob o header de “Itens da Venda”, **fora** da tabela (antes de `.pdv-itens-scroll`) |
| Limpeza | Remove banner legado já preso dentro de `<table>` |
| Mensagem operador | `resumirMensagemSelecaoEmpresaPdv` — texto curto, sem gargalos |
| Diagnóstico | `console.warn('[PDV][selecao-empresa]', …)` com mensagem/código/seleção brutos |
| Toast | `showNotification` usa o resumo (não a lista técnica) |
| Atualização | Sucesso / carrinho vazio / novo 409 continuam via `renderBannerSelecaoEmpresaPdv` |

**Não alterado:** motor de estoque, seletor, ficha, regras F×NF, PDV Universal, saldos, liberação de bloqueios.

## 3. Arquivos

| Arquivo | Ação |
|---|---|
| `frontend/pdv/js/pdv.js` | Ancoragem + resumo + diagnóstico |
| `tests/pdv/pdv-multiempresa-12-mensagem-capacidade-ui.test.js` | **Criado** |
| `docs/arquitetura/PDV-MULTIEMPRESA-12-RELATORIO.md` | Este relatório |

## 4. Testes

```text
node --test tests/pdv/pdv-multiempresa-12-mensagem-capacidade-ui.test.js
```

Cenários cobertos: ancoragem fora da tabela; 409 com vários gargalos sem texto técnico na UI; códigos caixa/matriz; contrato de limpeza no sucesso; notificação resumida; `atualizarCarrinho` intacto.

## 5. Resultado visual esperado

- Lista de produtos: colunas e rolagem normais (banner não invade a tabela).
- Bloqueio: faixa discreta vermelho-clara com frase curta (ex.: “Estoque insuficiente para a venda nesta empresa…”).
- Detalhe técnico: apenas no console DevTools (`[PDV][selecao-empresa]`).
- Venda permanece bloqueada quando a capacidade é insuficiente (snapshot/`selecaoEmpresaPdvSnapshot` continua null no 409).

## 6. Encerramento

Instalador **não** reconstruído. Recarregar o PDV a partir do worktree (`npm start`) para ver o efeito.

**Estado: CONCLUÍDA**
