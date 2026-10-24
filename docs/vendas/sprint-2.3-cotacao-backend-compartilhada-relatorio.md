# Sprint 2.3 — Cotação backend compartilhada

## 1. Resumo
- **Implementação efetiva** (não apenas auditoria): núcleo numérico unificado + serviço `CotacaoPrecoProdutoService`.
- **Testes unitários** isolados executados e aprovados (seção 7).
- **Integração real com o PDV: NÃO realizada.** O PDV não chama o serviço; a composição fiscal **não** usa a cotação. Não há afirmação de paridade com o PDV além do que os testes unitários mostram (reprodução das regras lidas em `pdv.js`; o `pdv.js` em si não foi executado).

## 2. Arquitetura numérica compartilhada
- Fonte única: `frontend/shared/js/motor-preco-atacado.js`, agora UMD: continua definindo o global `MotorPrecoAtacado` (browser e testes pdv-universal) e faz `module.exports` quando em Node.
- `backend/services/vendas/MotorPrecoAtacado.js` virou um reexport (`require` da fonte única). Mesmo objeto nos dois mundos (teste verifica identidade).
- API pública preservada (9 funções + `CASAS_INTERNAS`); adicionada a constante `NUCLEO_VERSAO = 'motor-preco-atacado/1'` (usada no fingerprint; incrementar em qualquer mudança numérica).
- Risco: o backend agora depende de arquivo em `frontend/`. O `package.json` empacota `**/*` (inclui ambos); não foi verificado `scripts/prebuild-electron.js` nem um build Electron real.

## 3. Serviço de cotação
`backend/services/vendas/CotacaoPrecoProdutoService.js` — `cotarPrecoProduto({ db, empresaId, produtoId, quantidade, tipoVenda, agora, valoresInformados })`.

Entrada: `db` e `empresaId` obrigatórios; `tipoVenda` ∈ `PESO` (padrão, modo normal) | `UNIDADE` | `ETIQUETA_BALANCA`; `agora` injetável.
Saída: `produtoId, empresaId, quantidade (normalizada), tipoVenda, precoBase{fonte,valor}, regrasAplicadas[{tipo,id}], precoUnitarioInterno, precoUnitarioExibicao, subtotalInterno, subtotalCentavos, regraArredondamento, cotadoEm, fingerprint, efeitosOperacionais:false, reservaSaldo:false` e, opcionalmente, `validacaoInformados{confere,divergencias}`.
Erros estruturados (`CotacaoPrecoErro.codigo`): `CONEXAO_OBRIGATORIA, EMPRESA_OBRIGATORIA, PRODUTO_INVALIDO, PRODUTO_INEXISTENTE, TIPO_VENDA_INVALIDO, QUANTIDADE_INVALIDA, PRECO_BASE_INVALIDO, VENDA_UNIDADE_NAO_PERMITIDA, SCHEMA_INCOMPATIVEL, DATA_REFERENCIA_INVALIDA`.

Somente `SELECT` e `PRAGMA table_info`; sem DDL, sem importar `database.js`.

## 4. Regras reproduzidas (referência: `pdv.js`, `adicionarItemNoCarrinho`)
| Modo | Preço-base | Promoção | Atacado | Quantidade |
|---|---|---|---|---|
| PESO (normal) | `preco_venda` | sim | sim, se `venda_atacado=1` | 2 casas se fracionado/kg, senão inteira |
| UNIDADE | `preco_unidade` (exige fracionado + `permite_venda_unidade=1`) | não | não | inteira |
| ETIQUETA_BALANCA | `preco_venda` | não | não | 3 casas |

- Promoção: `status='ativa' AND date(data_inicio) <= ref AND date(data_fim) > ref`, primeira por `id` (mesma condição de `GET /produtos/:id/promocao-ativa`). `preco_promocional` 0/nulo recai no preço base (como `||` no PDV).
- Atacado: maior `quantidade_minima <= quantidade`; `preco_atacado <= 0` ⇒ sem atacado; `calcularLinhaAtacadoFaixa`; preço final = `min(preço promo/base, preço atacado)`.
- Subtotal: `calcularLinhaPrecoUnitarioInformado` (interno 6 casas, total 2 casas, centavos = `round(total*100)`).

### Diferenças / ambiguidades (decisão de negócio pendente — nada escolhido silenciosamente)
1. `data_fim` é **exclusiva** no endpoint (usada aqui, como o carrinho) e **inclusiva** em `QueryOptimizer` (MIB, usado na consulta de preço do PDV). Os dois podem divergir no último dia.
2. O endpoint usa `date('now')` (UTC). A cotação usa a data UTC de `agora`. Perto da meia-noite local pode divergir do dia local.
3. `ORDER BY id` foi adicionado para determinismo; o endpoint não ordena (equivalente na prática por rowid, não provado).
4. A quantidade normalizada usa a regra `produto_fracionado/vendido_por_peso/unidade kg` lida no PDV; o fluxo "item já existente" soma quantidades no carrinho — a cotação cota apenas a quantidade pedida (o chamador deve informar a quantidade total da linha).
5. `subtotalFixo` de etiqueta de balança (valor da etiqueta) não é reproduzido.
6. Combinação com preço de itens já no carrinho (`precoFinal` vindo do item) não é reproduzida; a cotação parte só dos dados persistidos.

## 5. Fingerprint (SHA-256 de JSON canônico)
Inclui: versão da cotação, regra de arredondamento + versão do núcleo, produto, modo, quantidade normalizada, fonte/valor do preço-base, config de unidade (apenas modo UNIDADE), promoção selecionada (id, preço, status, datas, data de referência), faixas de atacado consultadas + faixa escolhida (apenas se `venda_atacado=1`), preço unitário interno, subtotal interno e centavos. Não inclui `cotadoEm` nem `empresaId` (preço global). Não reserva saldo nem garante validade futura; a conclusão da venda deve recalcular/revalidar.

## 6. Interface para integrar à composição fiscal (NÃO implementada)
`buscarComposicao` assume `preço × quantidade` com preço constante por produto. Para usar a cotação:
1. Pré-computar, por modelo, a função `subtotalCentavos(q)` chamando `cotarPrecoProduto` para q = 0..qMax (qMax limitado por capacidade/volume/saldo/reserva); com atacado, o preço depende da quantidade, então não usar multiplicação.
2. Substituir `qty*preço` pela tabela `subtotal[q]` e o limite superior de poda por `max` do subtotal por modelo (a monotonicidade do subtotal **não é garantida** com atacado — um subtotal maior com menos itens pode ocorrer; a poda deve usar limites seguros ou tabela completa).
3. Manter: exato primeiro; depois maior total ≤ residual; desempate lexicográfico; `INCONCLUSIVA` inutilizável ao estourar o limite de estados.
4. Incluir os fingerprints das cotações no fingerprint da composição.
Esses itens exigem testes próprios e ficam para a próxima sprint.

## 7. Testes realmente executados (SQLite `:memory:`, `DB_DIR` temporário removido ao fim)
| Arquivo | Resultado |
|---|---|
| `tests/vendas/sprint-2-3-cotacao-backend.test.js` (novo) | 18 passam, 0 falham |
| `tests/vendas/rcm-atacado-02-precisao-desconto.test.js` | 11/11 |
| `tests/pdv-universal/preco-atacado-05-35.test.js` | 1/1 |
| `tests/pdv-universal/promocao-comercial-05-36.test.js` | 1/1 |
| `tests/vendas/sprint-2-motor-composicao-fiscal.test.js` | 26/26 |

Cobertura dos novos testes: preço regular; unidade; etiqueta; promoção ativa/inativa/expirada/futura/preço 0; atacado abaixo/limiar/acima e subtotal por quantidade; promoção+atacado; atacado ignorado (flag 0, preço ≤ 0, ≥ base); interno vs exibição; arredondamento; fingerprint (quantidade, atacado, promoção, faixa, preço-base, status, preco_unidade, estabilidade); empresa obrigatória e preços globais; valores informados apenas comparados; erros; somente leitura (proxy de conexão só aceita SELECT/PRAGMA, snapshot de schema/dados e tabelas operacionais vazias de venda, estoque, contas, ficha técnica); inspeção de fonte (sem `database`, sem DDL/DML).

**Não executados:** suíte completa do repositório; testes do `pdv.js` real (comparação de paridade executável com o carrinho); build Electron; testes com banco real; `data_fim`/UTC contra o endpoint HTTP.

## 8. Isolamento
Todos os testes usaram bancos em memória e `DB_DIR` temporário apagado. O banco oficial/operacional não foi acessado. Sem commit, push ou merge. Sem alteração em PDV, carrinho, conclusão de venda, `FaturamentoService`, SEFAZ, TEF/PIX. Alterações preexistentes do workspace não foram tocadas.

## 9. Arquivos alterados/criados
- Alterado: `frontend/shared/js/motor-preco-atacado.js` (UMD + `NUCLEO_VERSAO`).
- Alterado: `backend/services/vendas/MotorPrecoAtacado.js` (reexport).
- Criado: `backend/services/vendas/CotacaoPrecoProdutoService.js`.
- Criado: `tests/vendas/sprint-2-3-cotacao-backend.test.js`.
- Criado: este relatório.

## 10. Próximos passos
1. Decidir as ambiguidades da seção 4 (data_fim, UTC/local).
2. Integrar a cotação à busca da composição com testes (seção 6).
3. Teste de paridade executável cotação × lógica do `pdv.js` (extrair função pura ou harness).
4. Expor/consumir a cotação no PDV e revalidar no backend na conclusão da venda (fluxo atual confia no payload).
5. Validar empacotamento Electron com a dependência backend → `frontend/shared`.
