# Sprint — Volume opcional em produtos comerciais

## Resumo

Foi adicionado um atributo opcional para informar o volume comercial de produtos `COMERCIAL`, recuperável pelo cadastro e pelo contrato de leitura do produto. O campo não altera unidade de estoque, apresentações comerciais, conversões MUC ou qualquer fluxo de venda.

## Arquivos criados e alterados

Criados:

- `backend/services/produtos/VolumeComercialProdutoService.js` — validação, normalização e contrato de leitura do volume.
- `tests/produtos/volume-comercial-produto.test.js` — testes em SQLite isolado.
- `docs/vendas/volume-comercial-produtos-relatorio.md` — este relatório.

Alterados:

- `backend/database.js` — novas colunas no schema de produtos e migrações compatíveis com bancos legados.
- `backend/rotas/produtos.js` — validação na criação/edição e disponibilização no retorno do produto.
- `frontend/erp/js/produtos.js` — controle e validação no modal compartilhado, exibido apenas para cadastro comercial.

As alterações preexistentes do workspace foram preservadas.

## Contrato implementado

Novas colunas em `produtos`:

- `utiliza_volume INTEGER NOT NULL DEFAULT 0`
- `volume_valor REAL`
- `volume_unidade TEXT`

O indicador desligado é o estado padrão. Produtos existentes recebem `utiliza_volume = 0` na migração; não há preenchimento automático nem inferência pelo nome, código de barras, embalagem ou unidade de estoque.

Com o indicador ligado, o backend exige volume numérico finito e positivo e unidade válida. O seletor oferece `ML` e `L`; a validação usa a normalização/família de unidades existente do MUC (`unidadesSi.js`), aceitando apenas unidades reconhecidas da família `VOLUME`. O MUC e seu catálogo não foram alterados.

Ao desativar um volume já configurado, o backend grava `utiliza_volume = 0` e mantém os valores armazenados. A resposta normalizada do produto retorna `volume_valor` e `volume_unidade` como `null` enquanto o indicador estiver desligado; assim, o contrato de leitura não apresenta os valores antigos como volume ativo. Um consumidor futuro deve respeitar `utiliza_volume` e não consultar diretamente os valores brutos sem verificar o indicador.

O cadastro de insumos não exibe o controle na página de insumos. Para `INSUMO`, a rota não aplica campos de volume; a resposta também os apresenta desativados. Se um produto comercial for convertido em insumo, eventual volume não é usado pelo contrato de leitura. Ao retornar de insumo para comercial sem nova configuração explícita, a flag é mantida desligada.

## Arquivos e comportamentos auditados

- O schema principal de `produtos` fica em `backend/database.js`, com migrações de colunas existentes no mesmo arquivo.
- Criação, edição e leitura por ID passam por `backend/rotas/produtos.js`; a leitura já usa `p.*`, e a normalização foi estendida para expor o novo contrato sem mudar os contratos de estoque e preço.
- O formulário de produtos e insumos compartilha `frontend/erp/js/produtos.js`; a exibição está condicionada à página/tipo operacional e não aparece na página `insumos`.
- Apresentações comerciais são persistidas em estrutura própria. Elas representam embalagem/conteúdo de apresentação, não o atributo de volume do produto físico; por isso não foram reutilizadas.
- A unidade de estoque e as relações MUC permanecem independentes do volume comercial.

## Testes executados

Todos os testes utilizaram `:memory:` ou arquivo SQLite temporário; nenhum teste abriu o banco oficial.

| Comando | Resultado |
|---|---|
| `node --check` nos arquivos JS alterados/criados | OK |
| `node tests\produtos\volume-comercial-produto.test.js` | Passou; migração em schema legado, padrão desligado, criação, edição, validação, desativação, recuperação e reabertura |
| `node tests\pastelaria\fundacao-produtos-ficha-tecnica-03-03.test.js` | 25/25 |
| `node tests\pastelaria\separacao-produtos-insumos.test.js` | Passou |
| `node tests\produtos\produto-infra-01.test.js` | 6 OK, 0 falhas |
| `node tests\estoque\create-produto-saldo-inicial-porta-publica.test.js` | 10/10 |
| `node tests\muc\muc-03-configuracao-produto.test.js` | 29/29 |
| `node tests\muc\muc-public-contract.test.js` | 20 OK, 0 falhas |
| Verificação estática do `INSERT INTO produtos` | 41 colunas e 41 placeholders |

O teste novo cobre: volume ausente/desativado; `200 ML`; unidade `L` com valor decimal; rejeição de zero, negativo, `NaN`, infinito, formato numérico inválido e unidade incompatível/desconhecida; edição de produto com volume; payload sem os novos campos sem apagar a configuração; desativação mantendo valores brutos, mas removendo-os do contrato ativo; produto legado; produto do tipo `INSUMO` no contrato de leitura; e persistência após fechar e reabrir um arquivo SQLite temporário.

Na primeira execução do teste novo, uma expectativa ainda apontava para o valor anterior à edição (`200`); foi ajustada para o valor efetivamente editado (`350`) e a execução final passou. Não houve mudança de regra por causa dessa correção.

## Limitações e pendências

- Não foi feita validação visual do modal em navegador.
- Não foi executado um teste HTTP ponta a ponta das rotas; a validação de domínio e a persistência foram exercitadas diretamente em SQLite isolado, e os pontos de integração das rotas foram verificados estaticamente e por sintaxe.
- A migração foi executada nos testes isolados usando as mesmas instruções exportadas pelo serviço e aplicadas pelo `backend/database.js`; não foi aplicada a banco operacional.
- Não foi criado histórico de alterações de volume. Ao desativar, os valores existentes são preservados no registro e ocultados da resposta normalizada; o histórico de auditoria genérico existente continua sendo usado no fluxo de edição.
- Nenhum consumo físico, composição fiscal, reserva, baixa de estoque ou uso do volume no Motor de Vendas foi implementado.

## Confirmações

- Cadastro e fluxo de produtos `INSUMO` permanecem sem controle de volume; o JavaScript compartilhado só renderiza/valida o recurso quando aplicável.
- O MUC, suas relações e contratos, apresentações comerciais, compras, estoque, ficha técnica e fluxos de venda não foram alterados para usar esse atributo.
- Nenhuma comunicação com SEFAZ foi executada.
- O banco oficial não foi acessado, aberto ou migrado.
- Não foram executados commit, push, merge ou reset.
