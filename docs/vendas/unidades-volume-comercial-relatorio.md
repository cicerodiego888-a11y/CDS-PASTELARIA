# Unidades personalizadas de volume comercial

## Diagnóstico e decisão

O cadastro anterior oferecia apenas `ML` e `L`, armazenados em `produtos.volume_unidade` como sigla. Não havia um cadastro persistente adequado para outras unidades. O MUC contém unidades com significado de conversão e, por isso, não é uma fonte apropriada para unidades de volume que servem somente como identificação comercial.

O cadastro de produtos é compartilhado no modelo atual. O novo catálogo `unidades_volume_comercial` segue esse mesmo escopo global; não foi introduzido compartilhamento entre cadastros que antes fossem isolados por empresa.

## Implementação e contrato

- Criada a tabela `unidades_volume_comercial`, com ID estável, nome, sigla, sigla normalizada única, ativo/padrão e timestamps.
- A inicialização idempotente semeia `ML` e `L` sem sobrescrever linhas já existentes, adiciona `produtos.volume_unidade_id` quando necessário e associa os produtos legados que utilizam essas duas siglas.
- O contrato de produto mantém `volume_unidade` como sigla, acrescenta `volume_unidade_id` e disponibiliza `volume_unidade_nome` nas leituras detalhadas. Produtos antigos continuam legíveis; associações antigas a `ML`/`L` são preenchidas pela migração.
- Os endpoints `GET /api/produtos/unidades-volume` e `POST /api/produtos/unidades-volume` exigem autenticação e permissão `produtos`. O GET lista unidades ativas; o POST cria uma unidade e responde com `201`; sigla duplicada após normalização responde `409`.
- O seletor e o formulário compacto de criação de unidades aparecem dentro da seção de volume do cadastro comercial. Após criar, a lista é atualizada e a nova unidade fica selecionada. A edição restaura o ID da unidade; se um produto histórico estiver associado a uma unidade inativa, sua associação atual é exibida para preservação, mas a unidade não entra na lista de novas opções.
- Siglas são normalizadas para maiúsculas, removendo espaços, e devem conter de 1 a 10 caracteres alfanuméricos. O nome é obrigatório, limitado a 80 caracteres e não aceita controles. A restrição `UNIQUE` do banco impede duplicidade concorrente. Associação nova exige ID existente e ativo; somente o produto já associado pode preservar uma unidade inativa.
- Ao desativar o volume no produto, a associação por ID é limpa. Os dados legados de sigla e valor podem permanecer armazenados, mas a leitura retorna volume desativado e não os disponibiliza como configuração ativa.

Uma unidade personalizada é apenas identificadora: não ganha equivalência nem conversão para `ML`/`L`. `volume_unidade` segue sendo uma sigla de apresentação; o ID identifica o cadastro de forma estável.

## Arquivos desta sprint

- `backend/services/produtos/VolumeUnidadeComercialService.js` — catálogo, migração idempotente, validações e associação.
- `backend/services/produtos/VolumeComercialProdutoService.js` — compatibilidade do contrato de volume com ID e metadados.
- `backend/database.js` — inicialização do catálogo e migração.
- `backend/rotas/produtos.js` — listagem/criação de unidades, validação de associação e persistência nas rotas de produto.
- `frontend/erp/js/produtos.js` — seletor dinâmico e formulário rápido no contexto comercial.
- `tests/produtos/unidades-volume-comercial.test.js` — testes isolados da nova persistência.
- `tests/produtos/volume-comercial-produto.test.js` — expectativas do contrato ampliado.

## Testes executados

- `node tests/produtos/unidades-volume-comercial.test.js` — passou: migração legada repetida, preservação/backfill de `ML` e `L`, cadastro e normalização, duplicidade, entradas inválidas, associação por ID, resposta do produto, unidade inativa e persistência após reabrir o banco temporário.
- `node tests/produtos/volume-comercial-produto.test.js` — passou: compatibilidade e validação anteriores de volume comercial, incluindo banco isolado e reabertura.
- `node tests/produtos/produto-embalagens.test.js` — 14 aprovados, 0 falhas.
- `node tests/produto-identidade/mip-sprint06-cadastro.test.js` com `$env:DB_DIR` apontando para diretório temporário isolado — 13 aprovados, 0 falhas. A primeira tentativa sem `DB_DIR` foi bloqueada pelo guardião de banco oficial; a execução repetida usou o diretório temporário, removido ao final.
- `node tests/motor-conversao-unidades/motor-conversao-unidades.test.js` — 15 aprovados, 0 falhas. O processo emitiu aviso preexistente de dependência circular envolvendo `recalcularEstoqueConsolidado`.
- `node --check` — passou para os serviços de volume, `backend/rotas/produtos.js`, `backend/database.js`, `frontend/erp/js/produtos.js` e os dois testes de produtos.

Os testes executados usam SQLite em memória ou arquivos temporários isolados. Não foi executado teste HTTP com servidor nem validação visual no sistema; portanto, a interface e as rotas não são declaradas visualmente ou end-to-end validadas.

## Limites e proteções

- A criação de unidade foi testada através do serviço de persistência, não por requisição HTTP concorrente real. A restrição única do SQLite é a proteção contra duplicidade concorrente.
- Não foram exercitados no navegador o modal, permissões de usuários específicos ou a edição visual de produto.
- O cadastro de insumos não recebeu controles ou campos novos; os campos de volume continuam restritos à seção comercial e o serviço de resposta mantém o comportamento de ocultação para insumos.
- Não houve alteração funcional no MUC, `unidadesSi.js`, conversões de estoque, embalagens, compras, ficha técnica, vendas ou fluxos fiscais.
- O banco oficial `C:\ProgramData\MercantilFiscal\dados` não foi acessado, aberto, migrado ou alterado. Não houve operação real na SEFAZ, nem commit, push, merge, reset ou rollback destrutivo.
