# CE-COMPRA-CLASS-03 — Preservar o produto vinculado à NF-e

## Causa raiz

Após a CE-COMPRA-CLASS-02, a linha apresentava a classificação operacional confirmada como texto, mas continuava renderizando um `<select>` de produtos. Assim, um item cujo vínculo MIIP estava validado ainda mostrava o catálogo filtrado e permitia substituição acidental do produto.

O estado normalizado mantém `produto_id`; a classificação é resolvida contra o registro de mesmo `id` na lista carregada pelo `GET /produtos`. O backend valida o `produto_id` e compara o `tipo_operacional` recebido com o cadastro antes de processar a compra. Nenhuma alteração de backend foi necessária.

## Correção

- Quando o vínculo MIIP está confirmado ou é uma associação automática válida, o ID corresponde ao produto existente no catálogo e a classificação operacional é válida/consistente, a linha exibe nome do cadastro e classificação como informações somente leitura. A lista de produtos não é renderizada.
- Para itens sem vínculo confiável, a lista suspensa continua disponível.
- Vínculos divergentes ou cadastros ausentes continuam com aviso explícito; o renderer não muda `produto_id` nem seleciona outro cadastro.
- A normalização continua preservando o ID original e o payload continua enviando `produto_id` e `tipo_operacional` já validados pelas regras existentes do backend.

## Arquivos alterados

- `frontend/erp/js/compras.js` — escolha entre apresentação somente leitura para vínculo MIIP validado e seletor para associação/revisão.
- `tests/compras/ce-compra-class-01.test.js` — agora cobre a linha real renderizada, vínculo manual confirmado, associação automática válida, itens pendentes/divergentes, rerender e preservação dos campos do payload.
- `docs/arquitetura/CE-COMPRA-CLASS-03-RELATORIO.md` — este relatório.

## Testes e evidências

- `node tests/compras/ce-compra-class-01.test.js` — passou. Executa `normalizeItemCompra` e `renderItensCompraTabelaCore` reais; verifica HTML do nome/classificação e ausência do seletor para vínculos confirmados e automáticos válidos. Após normalização repetida e rerender, confirma que os IDs originais permanecem inalterados. Também confirma seletor disponível para itens sem vínculo e aviso sem substituição para vínculo divergente.
- `node --check frontend/erp/js/compras.js` — passou.
- `node --check tests/compras/ce-compra-class-01.test.js` — passou.
- `node tests/compras/rc4312-central-fluxos.test.js` — 5 testes passaram.
- `node tests/compras/classificacao-itens-nfe-compra.test.js` — 15 testes passaram, incluindo persistência e validação backend do `tipo_operacional`.

O teste de integração utiliza SQLite temporário em `%TEMP%`. Nenhum banco oficial ou de cliente foi acessado; não houve compra real, movimentação real de estoque nem transmissão à SEFAZ.

## Resultado

Vínculos MIIP confirmados e consistentes aparecem como produto associado e classificação informativa, sem seletor de catálogo. Itens sem vínculo continuam selecionáveis; inconsistências são sinalizadas sem troca silenciosa.
