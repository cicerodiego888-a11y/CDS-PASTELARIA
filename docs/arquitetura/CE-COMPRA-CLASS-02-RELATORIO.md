# CE-COMPRA-CLASS-02 — Corrigir classificação não aplicada na interface

## Causa raiz

A revisão manual da Central MIIP não atualiza `miip_resultado.associadoAutomaticamente` nem `miip_sugestao.status`. Ao confirmar um item, o código real da Central grava `produto_id` e `miip_revisao_status: 'confirmado'` no item da sessão e devolve esses itens no resultado. O resolver de CE-COMPRA-CLASS-01 reconhecia somente associação automática e sugestão MIIP confirmada; por isso ignorava o vínculo manual confirmado usado pelo fluxo real. A normalização então deixava a classificação vazia, e a linha mostrava novamente “Selecione o tipo”.

O `produto_id` recebido é o identificador do cadastro de produtos usado pela compra. A lista carregada pelo `GET /produtos` retorna `p.id` e `p.tipo_operacional`; o vínculo só é classificado se esse ID confirmado existir no catálogo com tipo operacional válido.

## Correção

O resolver também reconhece `miip_revisao_status: 'confirmado'` como confirmação explícita do vínculo em `produto_id`. Continua exigindo que o cadastro correspondente esteja disponível e tenha `tipo_operacional` exatamente `INSUMO` ou `COMERCIAL`. Não há fallback automático para Comercial. A classificação resolvida permanece na normalização da linha e no campo `tipo_operacional` já utilizado pelo payload de compra; validações do backend não foram alteradas.

O teste de aceite agora executa as funções reais de normalização e `renderItensCompraTabelaCore`, que invoca o renderizador real da associação da linha. Fixtures de itens confirmados MIIP usam os casos `CEBOLA PERA KG`, `ERVILHA FUGINI`, `ÓLEO DE SOJA` e `OVO`. O HTML renderizado é verificado para conter os rótulos de tipo corretos e não conter “Selecione o tipo”. Casos sem vínculo ou cadastro classificado são renderizados com o seletor e aviso de pendência.

## Arquivos alterados nesta correção

- `frontend/erp/js/compras.js` — reconhecimento do status de confirmação manual gravado pela Central MIIP.
- `tests/compras/ce-compra-class-01.test.js` — teste de linha renderizada por caminho real, normalização e persistência do tipo normalizado.
- `docs/arquitetura/CE-COMPRA-CLASS-02-RELATORIO.md` — este relatório.

## Testes e evidências

- `node tests/compras/ce-compra-class-01.test.js` — passou; validou tipos `INSUMO` e `COMERCIAL`, apresentação no HTML da linha, ausência do seletor em vínculos classificados, seletor presente em pendências e tipos preservados pela normalização.
- `node --check frontend/erp/js/compras.js` — passou.
- `node --check tests/compras/ce-compra-class-01.test.js` — passou.
- `node tests/compras/rc4312-central-fluxos.test.js` — 5 testes passaram.
- `node tests/compras/classificacao-itens-nfe-compra.test.js` — 15 testes passaram.
- `node tests/central-entradas/ce-ux31-review-flow.test.js` — passou.

O teste de integração usou SQLite temporário em `%TEMP%`; nenhuma base oficial ou do cliente foi acessada. Não houve compra real, movimentação de estoque real ou comunicação com a SEFAZ.

## Resultado

Vínculos MIIP confirmados manualmente pela Central agora obtêm a classificação do cadastro de mesmo ID e exibem “Insumo” ou “Produto Comercial” na linha. Itens sem classificação confiável continuam exigindo escolha explícita.
