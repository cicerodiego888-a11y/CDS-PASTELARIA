# Auditoria e correção da duplicação de estoque em compras

## 1. Reprodução (banco temporário, `DB_DIR` isolado, HTTP real no router de compras)
- Embalagem: 2 CAIXA × 10, enviando fiscal=0 e não fiscal=20.
- Antes: `compras_itens.quantidade_fiscal=20` e `quantidade_nao_fiscal=20`. Saldo creditado: 20 + 20 = **40** (esperado 20).
- Unidade comum (10 un): creditava 10, correto.

## 2. Fluxo mapeado
`POST /compras` (`backend/rotas/compras.js`) → `processarItensCompra` → MUC (`MotorConversaoCalculo.executar`) → `resolverQuantidadesEstoqueCompraItem` (`backend/lib/motorConversaoUnidades.js`) → crédito fiscal + não fiscal (`services/compras/creditoEstoqueCompraViaPorta.js`, soma correta, não alterado). O cancelamento debita pelas quantidades persistidas, de forma simétrica.
Ficha técnica: não há referência a ficha em `compras.js` nem em `services/compras/*.js`. Ela **não participa** do crédito de compra e não é causa da duplicação.

## 3. Causa raiz
No ramo `usaEmbalagemComercial` de `resolverQuantidadesEstoqueCompraItem`:
`quantidade_fiscal: Number(qtds.quantidade_fiscal || quantidade)`.
O valor 0 (válido, "tudo não fiscal") era tratado como "não informado" e caía no fallback "tudo fiscal". Resultado: 20 fiscal (fallback) + 20 não fiscal (informado) = 40.

## 4. Correção
`quantidade_fiscal: soma > 0 ? Number(qtds.quantidade_fiscal || 0) : quantidade`
O fallback "tudo fiscal" só vale quando nenhuma divisão foi informada. Alteração só em `backend/lib/motorConversaoUnidades.js` (arquivo sem alterações preexistentes).

## 5. Verificação em outros cenários (após a correção)
Embalagem 0/20, 20/0 e 5/15; produto fracionado 0/20; unidade comum 0/10 e 10/0; COMERCIAL 0/20: todos creditam exatamente a quantidade esperada. A unidade comum e o ramo fracionado não tinham o bug.
Cancelamento zera o estoque nos cenários testados.

## 6. Testes (resultados reais)
- `tests/compras/custo-insumo-fluxo-compras.test.js` (estendido com testes de estoque/saldos): **18 OK, 0 falhas**. A proteção de custo/preço de venda do insumo continua passando.
- Regressão: 131 arquivos de `tests/{compras,motor-conversao-unidades,muc,estoque,pastelaria,produtos,embalagens}`, cada um com `DB_DIR` próprio: **111 passam, 20 falham**.
  - 19 dessas falhas também ocorrem no HEAD (extraído via `git archive`, mesmo procedimento), portanto são preexistentes: rc43110, rc43112.2, rc4312-central-fluxos, rc4314-insert-compras-alignment, rc840, ajuste-estoque-porta-publica, auditoria-escritores-operacionais-03-31, compras-multiempresa-contexto, debito-baixa-venda-porta-publica, inventario-ajuste-multiempresa-contexto, pdv-identificacao-estoque-empresa, pedido-disponibilidade-multiempresa, rc80z-produtos-ux, recalculo-saldos-porta-publica, reservas-pdv-porta-publica, 3 de importação inicial de produtos, rc852-mie.
  - 1 falha só no workspace: `listagem-produtos-empresa` (item 7).
  - Não investiguei a causa das 19 falhas preexistentes.

## 7. `listagem-produtos-empresa`
- Falha no `test14OrdemListagem`, na asserção de código-fonte (linha 277): `trecho.includes('ORDER BY p.id DESC')`, onde `trecho = src.slice(idx, idx+1800)` a partir de `router.get('/',`.
- A ordem real das linhas (asserções anteriores) passa; o comportamento da listagem não está quebrado.
- Em `backend/rotas/produtos.js`, a distância entre `router.get('/',` e `ORDER BY p.id DESC` é **1448 caracteres no HEAD** e **1863 no workspace**, acima da janela de 1800.
- Causa: alterações preexistentes do workspace em `produtos.js` (+106/−15 linhas), não relacionadas às sprints de compras.
- Nada foi revertido ou sobrescrito. Sugestão: ampliar a janela do teste ou revisar o diff de `produtos.js` com seu autor.

## 8. Riscos remanescentes
- O custo do insumo não é revertido ao cancelar/devolver compra (comportamento preexistente, sem alteração; requer proposta própria).
- `POST /:id/devolver` não foi exercitado.
- Conversões MUC entre unidades distintas (ex.: CAIXA→KG com relação cadastrada) não foram testadas.
- Compras já gravadas com quantidades duplicadas antes da correção não foram corrigidas (não houve acesso ao banco oficial); recomenda-se auditoria dos dados reais.
- 19 falhas preexistentes seguem sem diagnóstico.

## 9. Conformidade
Somente bancos temporários com `DB_DIR` isolado; banco oficial não aberto nem alterado. Central de Entradas, SEFAZ, fiscal e Motor de Vendas não modificados. Regra de custo das bonificações e política de cancelamento/devolução inalteradas. Nenhum commit, push, merge, reset ou descarte.
