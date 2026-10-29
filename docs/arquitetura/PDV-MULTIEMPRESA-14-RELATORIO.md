# PDV-MULTIEMPRESA-14 — Alinhamento da validação visual ao saldo elegível

**Data:** 2026-10-26  
**Módulo:** PDV oficial `/pdv` (UX / validação local)  
**Estado final:** **CONCLUÍDA**

## 1. Problema

`validarEstoqueVenda` (modo não fiscal) usava `saldoTotal = fiscal + não fiscal` como “disponível”, e o ramo fiscal comparava quantidade a esse total. O seletor/capacidade (M08/M13) usa **bucket exclusivo** da operação. O operador via estoque “suficiente” e depois 409 de capacidade com `disponivel: 0` no bucket elegível.

## 2. Correção (somente frontend PDV)

| Função | Comportamento |
|---|---|
| `pdvOperacaoVendaFiscal()` | Critério único: `emitir` explícito ou, se `null`, modo F12 |
| `pdvSaldoElegivelOperacao()` | Sem ficha → só F ou só NF; com ficha → `elegivel: null` |
| `validarEstoqueVenda` | Compara qty ao **elegível**; mensagem cita bucket e, se houver, o outro saldo como “não elegível nesta operação” |
| `pdvEstoqueDisponivel` / `pdvRotuloEstoque` | Exibem elegível (ou texto de ficha), **não** o total |
| `atualizarSelecaoEmpresaPdv` | `emitir_fiscal` / `venda_fiscal` = `pdvOperacaoVendaFiscal()` (mesmo critério da validação local) |

**Ficha técnica:** validação local **não** bloqueia pelo saldo do acabado (`diferidoSeletor: true`). Insumos por empresa permanecem autoridade do seletor/capacidade.

**Não alterado:** motor F×NF, `ServicoCapacidadeCarrinhoEmpresa`, persistência, soma entre CNPJs, PDV Universal, instalador.

## 3. Arquivos

| Arquivo | Ação |
|---|---|
| `frontend/pdv/js/pdv.js` | Alinhamento UX / validação local |
| `tests/pdv/pdv-multiempresa-14-validacao-saldo-elegivel.test.js` | Criado |
| `docs/arquitetura/PDV-MULTIEMPRESA-14-RELATORIO.md` | Este relatório |

## 4. Testes

```text
node --test tests/pdv/pdv-multiempresa-14-validacao-saldo-elegivel.test.js
node --test tests/pdv/pdv-multiempresa-12-mensagem-capacidade-ui.test.js tests/pdv/pdv-multiempresa-14-validacao-saldo-elegivel.test.js
```

| Cenário | Resultado |
|---|---|
| NF + só fiscal | Bloqueia; `Disponível (não fiscal): 0`; menciona fiscal não elegível |
| NF + NF suficiente | Permite |
| Fiscal + só NF | Bloqueia; elegível fiscal 0 |
| Ficha | Sucesso local diferido; rótulo sem total |
| Preview = `pdvOperacaoVendaFiscal` | Contrato no fonte |
| M12 regressão | Verde |

**7/7 M14 + M12 OK.**

## 5. Evidência: total ≠ elegível na UI

- Mensagem de falha usa `Disponível (fiscal|não fiscal): N`, nunca o `estoque_atual` como “Disponível”.
- Se o outro bucket > 0: linha explícita `(não elegível nesta operação)`.
- `pdvEstoqueDisponivel` retorna só o elegível (ou `null` com ficha).
- Capacidade multiempresa continua bloqueando quando nenhuma empresa atende (inalterada).

## 6. Encerramento

Recarregar o PDV a partir do worktree (`npm start`). Instalador **não** reconstruído.

**Estado: CONCLUÍDA**
