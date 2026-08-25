# LISTA — FUNCIONALIDADES EXCLUSIVAS DO PDV LEGADO

O que o Universal **ainda não absorveu** (código 05.19.1). Tudo **A MIGRAR** ou **RISCO DE REGRESSÃO** até comprovação.

## Operação de venda

1. Identificação MIP (`/produtos/identificar`) — barras, código interno, PLU no mesmo fluxo do leitor.
2. Modal consulta de produtos F1 (categorias, grade, foto).
3. Quantidade rápida F4 no último item.
4. Tabela com UN, desconto % e desconto R$ por linha.
5. Autorização supervisor para desconto (F8).
6. Desconto atacado no resumo (`motor-preco-atacado` + API).
7. Promoção ativa por produto.
8. Acréscimo no resumo.
9. Validação estoque fiscal vs não fiscal na inclusão.
10. Interpretação de etiqueta de balança (peso/valor) via Motor Equipamentos.
11. Produto fracionado / `peso_medio_unidade` / conversão de volume no item.
12. Tipo de venda **Entrega** (F9) + persistência `POST /api/vendas`.
13. Modal completo de entrega (CEP ViaCEP, taxa, maquineta, troco para, entregador).
14. Página Entregas: dashboard, iniciar, timeline.
15. Prestação de entrega no PDV (`pdv-prestacao-entrega.js`).
16. Widgets de footer (entregas pendentes / prestação).
17. Fluxo de pagamento rico: misto, prazo, cliente, parcelas, 1º vencimento.
18. Troco operacional (valor recebido).
19. PIX cobrança (`/api/pix/criar-cobranca` + polling status).
20. TEF débito/crédito/PIX TEF (`/api/tef/pagar`, cancelar, impressão TEF).
21. Confirmação fiscal avançada + emissão `POST /api/fiscal/emitir/venda/:id` no pós-venda legado.
22. Segunda etapa pagamento não fiscal (`/vendas/:id/pagamento-nao-fiscal`).
23. Pré-cálculo `POST /api/vendas/pre-calcular-distribuicao`.
24. Cancelar venda em curso (limpa carrinho) com ESC visível.
25. Impressão cupom não fiscal clássico + reimpressão (`vendas.js`).

## Caixa

26. Status aberto/fechado no header.
27. Abrir caixa, fechar (F7), sangria, suprimento, conferência por data, reimpressão de fechamento.

## Shell

28. Sidebar: Venda, Entregas, Consulta, Clientes, Caixa, Reimpressão, Nome PDV, Rede, Assinatura.
29. Calculadora flutuante.
30. Temas / aparência F11.
31. Relógio.
32. Fullscreen `pdv-mode` + menu hamburger.
33. Página Clientes embutida.
34. Terminal hostname / nome deste PDV.
35. Copiloto (carregado só no legado).

## O que NÃO é exclusivo (já existe caminho Universal)

- Criar venda EMPRESA_UNICA no motor VAS (Universal chama internamente).
- Atendimento MULTIEMPRESA, reserva, materializar, fiscalizar, comprovante unificado.
- Seleção de empresa oficial e disponibilidade por empresa.
- Formas dinheiro/PIX/débito/crédito **como enum** (sem integrações).

## Isolar (não migrar)

Qualquer regra que assuma **empresa 1 / empresa única hardcoded** no frontend legado. O caminho oficial de contexto é o PDV Universal.
