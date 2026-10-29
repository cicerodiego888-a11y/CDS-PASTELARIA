# CE-COMPRA-CLASS-01 — Classificação automática dos itens da compra

## Causa raiz

No lançamento de compra originado pela Central de Entradas, o item MIIP podia chegar vinculado a um cadastro existente, mas a normalização da tela removia a classificação operacional enquanto ela não estivesse marcada como confirmada pelo usuário. O renderizador então apresentava novamente o seletor obrigatório, mesmo quando o cadastro vinculado já continha `tipo_operacional`.

O endpoint existente `GET /produtos` retorna os campos do cadastro (`p.*`), incluindo `tipo_operacional`; o fluxo de Compras já carrega esse catálogo antes de abrir o lançamento. Não foi necessário criar endpoint, serviço, rota ou alterar schema.

## Implementação

- Para associações MIIP automáticas ou confirmadas, a tela confere o ID do vínculo com o cadastro carregado e lê a classificação operacional deste cadastro.
- Classificações válidas `INSUMO` e `COMERCIAL`, consistentes com o item, são normalizadas e apresentadas como informação (`Insumo` ou `Produto Comercial`) em vez de solicitar nova escolha.
- Cadastro ausente do catálogo, classificação ausente/inválida, divergência entre classificação informada e cadastro ou divergência entre o ID MIIP e o cadastro vinculado mantêm o fluxo explícito, exibem aviso e não escolhem um tipo silenciosamente.
- A classificação resolvida segue no campo `tipo_operacional` já enviado no payload da compra; a validação existente do backend continua verificando sua correspondência com o cadastro antes de processar itens.
- O seletor manual passou a tratar valor ausente ou inválido no cadastro como não classificado, sem aplicar o fallback de interface para `COMERCIAL`.

## Arquivos alterados

- `frontend/erp/js/compras.js` — resolução e apresentação da classificação vinculada, mantendo revisão explícita para casos inconsistentes.
- `tests/compras/ce-compra-class-01.test.js` — testes direcionados para vínculo automático/confirmado, tipos válidos, ausência/invalidade de cadastro e divergências.
- `docs/arquitetura/CE-COMPRA-CLASS-01-RELATORIO.md` — este relatório.

## Testes executados

- `node tests/compras/ce-compra-class-01.test.js` — passou.
- `node --check frontend/erp/js/compras.js` — passou.
- `node tests/compras/rc4312-central-fluxos.test.js` — 5 testes passaram.
- `node tests/compras/classificacao-itens-nfe-compra.test.js` — 15 testes passaram, incluindo persistência de `tipo_operacional` e validação de divergência.
- `node tests/central-entradas/ce-ux31-review-flow.test.js` — passou.

O teste de integração usou banco SQLite temporário em `%TEMP%`; nenhuma base oficial ou do cliente foi acessada. Não foram confirmadas compras reais, movimentado estoque real nem transmitidos eventos à SEFAZ.

## Resultado

Itens MIIP com vínculo válido e classificação consistente no cadastro não exigem classificação redundante. Casos sem classificação confiável continuam exigindo revisão explícita, e a classificação efetivamente enviada permanece sujeita às validações existentes do backend.
