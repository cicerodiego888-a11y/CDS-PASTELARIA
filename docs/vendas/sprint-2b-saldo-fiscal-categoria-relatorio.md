# Sprint 2B — Fundação do saldo fiscal compartilhado por empresa e categoria

## Objetivo e escopo
Fundação persistente do saldo fiscal lógico em ml por `(empresa_id, categoria_fiscal)` (`REFRIGERANTE`, `AGUA`), com ledger append-only, abertura autorizada, ajustes, estornos, consulta e conversão para ml pelo MUC. Fora do escopo (não feito): reservas, consumo em venda, composição fiscal, integração com Pedido/Venda/NF-e/financeiro, migração ou soma de saldos, entrada por documento, alertas, rotas/telas, ligação ao boot.

Relatórios das Sprints 0, 1 e 2A, bem como os arquivos da Sprint 1 (`categoriaFiscalEmpresaSchema.js`, `CategoriaFiscalEmpresaService.js`, `tests/vendas/categoria-fiscal-empresa.test.js`), estavam disponíveis e foram lidos/usados.

## Arquivos
Criados (nenhum arquivo existente foi modificado):
- `backend/services/vendas/saldoFiscalCategoriaSchema.js`
- `backend/services/vendas/SaldoFiscalCategoriaService.js`
- `tests/vendas/saldo-fiscal-categoria.test.js`
- `docs/vendas/sprint-2b-saldo-fiscal-categoria-relatorio.md`

Reutilizados sem alteração: `normalizarCategoriaFiscal` (Sprint 1), `obterMuc(db).converterQuantidade`, `ProdutoConversaoConfigService.obterConfiguracao` e `montarRelacoesMuc`.

## Schema e invariantes
`garantirSchemaSaldoFiscalCategoriaAsync(db)` (e a versão com callback) é explícita e idempotente; recebe a conexão do chamador, não abre banco, não cria linhas e **não é ligada ao boot**. O serviço a chama sob demanda (mesmo padrão de `estoque_empresa`).

`saldo_fiscal_categoria_empresa`: `empresa_id` NOT NULL com FK `empresas(id)`; `categoria_fiscal` CHECK `REFRIGERANTE|AGUA`; `unidade_base` CHECK `'ML'`; `saldo_atual_ml`, `saldo_reservado_ml`, `estoque_minimo_ml` inteiros ≥ 0 (`typeof = 'integer'`); `ativo` 0/1; timestamps; `UNIQUE(empresa_id, categoria_fiscal)`; `CHECK (saldo_reservado_ml <= saldo_atual_ml)`.

`saldo_fiscal_categoria_movimentos` (ledger): `tipo` CHECK `ABERTURA|AJUSTE_ENTRADA|AJUSTE_SAIDA|ESTORNO`; `direcao` ±1; `quantidade_ml` inteiro > 0; saldos anterior/posterior inteiros ≥ 0; `CHECK saldo_posterior = saldo_anterior + direcao*quantidade`; coerência tipo×direção; `ESTORNO` ⇔ `movimento_estornado_id` preenchido; operador obrigatório (`usuario_id` ou `origem_sistemica`); `origem` `MANUAL|SISTEMA`; referência (tipo+id) e motivo não vazios; `UNIQUE(empresa_id, idempotency_key)`; `produto_id`, `quantidade_origem`, `unidade_origem`, `metadados_json`, `created_at`.
FKs verificadas: `empresas(id)`, saldo `(empresa_id, categoria_fiscal)`, o próprio ledger (`movimento_estornado_id`) e `produtos(id)`. `usuario_id` **não** tem FK (a tabela de usuários não foi verificada).
Índices/gatilhos: índice único parcial de estorno por movimento (um estorno por original); índice único parcial de uma `ABERTURA` por saldo; índice `(empresa, categoria, created_at)`; triggers que abortam `UPDATE` e `DELETE` no ledger; trigger que exige estorno da mesma empresa/categoria do original.
Limitação: a lista de `tipo` é um CHECK; novos tipos (reserva, consumo) exigirão recriar a tabela numa sprint futura.

## API real (`SaldoFiscalCategoriaService`)
Todas recebem `(params, { db })`; erros têm `code` estável e `statusCode`.
- `garantirSaldo({empresaId, categoriaFiscal})` — cria saldo zerado, sem movimento.
- `obterSaldo(...)` — `{empresaId, categoriaFiscal, unidadeBase, saldoAtualMl, saldoReservadoMl, saldoDisponivelMl, estoqueMinimoMl, ativo}`; **retorna `null` se não existe**, sem criar dados.
- `registrarAbertura({..., quantidadeMl, usuarioId|origemSistemica, motivo, referencia:{tipo,id}, confirmado:true, idempotencyKey})`.
- `ajustar({..., tipo:'AJUSTE_ENTRADA'|'AJUSTE_SAIDA', quantidadeMl, ...})`.
- `estornar({empresaId, categoriaFiscal, movimentoId, usuarioId|origemSistemica, motivo, referencia, idempotencyKey})`.
- `listarMovimentos(...)` (leitura, para auditoria/testes).
- `converterParaMl({produtoId, quantidade, unidade, apresentacoes?})`.
Retorno das mutações: `{ idempotente, movimento, saldo }`. Sem função de update/delete de movimento.

## Idempotência e transações
- Todas as mutações passam por um único núcleo: `BEGIN IMMEDIATE` → busca por `(empresa, idempotencyKey)` → validações → `UPDATE` condicional do saldo (`WHERE saldo_atual_ml = anterior AND saldo_reservado_ml = reservado`, `changes` verificado) → `INSERT` do movimento → `COMMIT`; qualquer erro faz `ROLLBACK`.
- As transações são **serializadas por conexão** (fila em `WeakMap`), pois a mesma conexão SQLite não aceita transações aninhadas. O serviço não deve ser chamado dentro de transação já aberta na mesma conexão.
- Repetição com a mesma chave e mesmos dados (tipo, categoria, quantidade, referência, motivo, operador, original do estorno) retorna o movimento original (`idempotente: true`); dados diferentes → `IDEMPOTENCY_CONFLITO` (409). A chave é única por empresa.
- Abertura: exige `confirmado === true`; deve ser o primeiro movimento (`ABERTURA_APOS_MOVIMENTOS`) e única (`ABERTURA_JA_REGISTRADA`); `garantirSaldo` nunca abre saldo.
- Saída/estorno de entrada: rejeitados com `SALDO_INSUFICIENTE` se `novo saldo < reservado` (inclui negativo).
- Estorno: novo movimento `ESTORNO` com direção oposta e a quantidade do original; `ABERTURA` e `ESTORNO` não são estornáveis (`MOVIMENTO_NAO_ESTORNAVEL`; correção por ajuste); duplicado → `ESTORNO_DUPLICADO`; movimento de outra empresa → `MOVIMENTO_NAO_ENCONTRADO`; de outra categoria → `MOVIMENTO_OUTRA_CATEGORIA`.
- Saldo `ativo = 0` bloqueia mutações (`SALDO_INATIVO`).

## Integração com o MUC e limitações verificadas
`converterParaMl` lê a configuração do produto (`obterConfiguracao`) e chama `obterMuc(db).converterQuantidade` com destino `ML`; não há segundo algoritmo e nada é gravado. Retorna `quantidadeMl`, origem/destino, `fatorTotal` e `caminho`; `ajustar`/`registrarAbertura` aceitam `conversao` opcional (deve bater com `quantidadeMl`) e gravam `produto_id`, `quantidade_origem`, `unidade_origem` e o caminho em `metadados_json`.
Comportamento real do MUC (verificado no código e nos testes):
- `UN → ML` sem nenhuma relação → o MUC devolve `CONVERSAO_INVALIDA`; com relações que não levam ao destino → `CONVERSAO_NAO_DISPONIVEL`. Os dois são repassados.
- Ciclos → `CONVERSAO_CICLO` (o MUC detecta).
- **O MUC não detecta caminhos ambíguos**: o BFS devolve o menor caminho e ignora relações duplicadas. Mitigação no adaptador (sem reimplementar conversão): para cada relação usada no caminho, repete-se a conversão no próprio MUC sem ela; se houver caminho alternativo com resultado diferente → `CONVERSAO_AMBIGUA`. Limitação: ambiguidade só é detectada quando existe caminho alternativo completo; alternativas com o mesmo resultado são aceitas.
- O MUC arredonda a 9 casas. O adaptador exige resultado **inteiro** nessa precisão; senão `CONVERSAO_FRACIONARIA`, sem arredondar.
- Produto com `utiliza_conversao = 0` só converte quando a unidade já é `ML` (decisão conservadora; `L→ML` em produto sem conversão é rejeitado).
- Apresentações comerciais (FARDO etc.) **não** são lidas do banco: o chamador as informa em `apresentacoes` (mesmo contrato de `simularConversaoProduto`). Não foi verificada a tabela de embalagens persistidas.
- `quantidade` de entrada é número JS (REAL); não foi tratado ponto flutuante além do arredondamento do MUC.

## Testes executados
Comandos (SQLite `:memory:`, sem acesso ao banco oficial):
- `node --check` nos 2 arquivos novos de serviço/schema — OK.
- `node tests\vendas\saldo-fiscal-categoria.test.js` — **passou** (saída final: `saldo-fiscal-categoria: todos os testes passaram`).
- `node tests\vendas\categoria-fiscal-empresa.test.js` (Sprint 1, regressão) — **passou**.
Primeira execução do teste novo falhou numa expectativa minha (`UN→ML` sem relação devolve `CONVERSAO_INVALIDA`, não `NAO_DISPONIVEL`); corrigi o teste para o comportamento real do MUC e reexecutei.

Cobertura efetivamente exercitada pelo teste: schema idempotente, unicidade, CHECKs (negativo, fracionário, categoria, reservado > atual) e FK de empresa; abertura (sem confirmação/motivo/referência/operador/chave, quantidades inválidas, segunda abertura, repetição idempotente, conflito, origem sistêmica); ajustes (entrada, saída, saldo insuficiente, saldo reservado, tipo inválido, idempotência e conflito); atomicidade (trigger de teste força falha no INSERT do movimento → saldo revertido e conexão utilizável); concorrência na mesma conexão (duas saídas, três repetições da mesma chave, dois estornos); estornos (válido, original preservado, repetição idempotente, duplicado, não estornável, inexistente, outra empresa/categoria, saldo insuficiente); ledger (UPDATE/DELETE bloqueados, linha inconsistente e estorno cruzado rejeitados no banco, soma do ledger = saldo e encadeamento anterior/posterior); isolamento empresa/categoria; conversão (UN→ML, FARDO 12 UN × 1 UN = 1000 ML → 12.000 ml, L→ML, sem relação, sem conversão, embalagem sem conteúdo, KG, unidade desconhecida, fracionário, ambíguo, ciclo, sem gravação); não regressão.
**Não testado:** concorrência entre conexões distintas (processos), contra arquivo SQLite em disco, desempenho, e `L→ML` em produto sem conversão (rejeitado por decisão).

## Evidências de isolamento e não regressão
- A empresa A não consulta/estorna movimentos da empresa B; `AGUA` e `REFRIGERANTE` têm saldos e ledgers independentes; não há linha global nem fallback de empresa; a mesma `idempotencyKey` é permitida em empresas diferentes.
- Snapshot comparado ao final do teste: `produtos` (saldo_fiscal, saldo_nao_fiscal, estoque_atual), `estoque_empresa`, `pedidos` e `vendas` idênticos ao início — nenhuma baixa, reserva ou alteração operacional.
- Nenhum cálculo a partir de `produtos.saldo_fiscal`; o vínculo da Sprint 1 não cria saldo.

## Limitações e decisões pendentes
- `usuario_id` sem FK; autorização do operador (quem pode abrir/ajustar) não é verificada — será responsabilidade da camada de rota/permissão.
- Fila de transações é por processo/conexão; entre conexões depende do `BEGIN IMMEDIATE` e do `UPDATE` condicional (`SALDO_CONFLITO_CONCORRENCIA`; `SQLITE_BUSY` é propagado).
- Os campos `saldo_reservado_ml` e `estoque_minimo_ml` existem mas nenhuma API os altera.
- Política da venda (substituir ou complementar a baixa por produto) e validade fiscal continuam pendentes (Sprint 2A §7).
- Definir onde garantir o schema em produção (boot ou migração controlada).

## Riscos e próximos passos
1. Sprint 2C: reservas por pedido (tabela própria com unidade ml, chave de idempotência por pedido/item), liberação e consumo, usando `saldo_reservado_ml`.
2. Integração com o Motor Comercial/venda respeitando os riscos da Sprint 0 (erro de consumo de reserva ignorado, vínculo pedido/venda fora da transação, reserva só fiscal).
3. Estoque mínimo/alertas por categoria.
4. Rota/permissão administrativa para abertura e ajustes, com autorização explícita.
5. Se houver múltiplos processos escrevendo, testar concorrência real entre conexões.

## Confirmações
Banco oficial (`C:\ProgramData\MercantilFiscal\dados`) não acessado; nenhuma operação na SEFAZ; nenhuma migração, boot, flag ou configuração alterados; nenhum commit/push/merge/reset; nenhum arquivo preexistente modificado.
