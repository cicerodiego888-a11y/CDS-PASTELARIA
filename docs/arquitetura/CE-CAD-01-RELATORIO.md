# CE-CAD-01 — Escolha do tipo de cadastro na Central de Entradas

## Causa

Na revisão MIIP, a ação F3 chamava diretamente o cadastro de Produtos. Embora o cadastro atual já suporte Produto comercial e Insumo, a tela de revisão não oferecia uma escolha explícita ao operador.

## Implementação

Foi adicionada uma janela de escolha com as opções **Produto comercial**, **Insumo** e **Cancelar**. A seleção encaminha o item capturado da NF-e para o `showProdutoModal` existente, informando explicitamente `tipo_operacional` como `COMERCIAL` ou `INSUMO`. A opção Cancelar e o fechamento da janela não chamam o cadastro nem confirmam/alteram o item da revisão.

Não foram criados formulários, rotas ou serviços de cadastro; nenhuma decisão de tipo é inferida pelo nome ou pela unidade do item.

## Arquivos alterados

- `frontend/erp/js/miip-central-revisao.js` — escolha do tipo e encaminhamento explícito ao cadastro existente.
- `tests/central-entradas/ce-cad-01-escolha-tipo-cadastro.test.js` — teste direcionado da escolha, cancelamento e reutilização do cadastro atual.
- `docs/arquitetura/CE-CAD-01-RELATORIO.md` — este relatório.

## Testes e resultado

- `node tests/central-entradas/ce-cad-01-escolha-tipo-cadastro.test.js` — passou.
- `node --check frontend/erp/js/miip-central-revisao.js` — passou.
- `node tests/central-entradas/ce-ux31-review-flow.test.js` — passou.
- `node tests/central-entradas/rc376-revisao-inteligente.test.js` — 27 testes passaram e 1 falhou em cada uma de duas execuções. A falha é `RC3.7.6.5 Modo foco restaura estado anterior`: o resultado contém `identificadores: true` enquanto o esperado não contém essa propriedade. Esse teste cobre restauração do modo foco no módulo de inteligência, não toca no fluxo F3/cadastro alterado nesta entrega.

Os testes executados são locais e não acessaram banco de dados oficial ou do cliente, estoque real ou SEFAZ.

## Resultado

O operador agora escolhe explicitamente qual cadastro existente abrir. Os dados importados e o contexto do item permanecem no fluxo de revisão; cancelar não aciona o cadastro nem altera o item. A alteração ficou restrita à decisão temporária solicitada.
