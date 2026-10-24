# Sprint 2C — Auditoria de integridade, concorrência e conversão do saldo fiscal compartilhado

## 1. Resumo executivo
- Concorrência entre **conexões SQLite independentes** (arquivo temporário, WAL, `busy_timeout`) testada em 8 cenários + carga; todos passaram, sem saldo negativo, perda de atualização, abertura/estorno duplicados ou divergência saldo × ledger.
- Achado 1 (corrigido): a identidade idempotente **ignorava** `produto_id`, `quantidade_origem` e `unidade_origem` (conversão). Agora fazem parte da comparação.
- Achado 2 (corrigido): transação externa ativa gerava erro SQLite cru; agora `TRANSACAO_EXTERNA_ATIVA` (409), antes de qualquer escrita e sem COMMIT/ROLLBACK sobre a transação do chamador.
- Achado 3 (corrigido): `SQLITE_BUSY` no `BEGIN IMMEDIATE` agora vira `SALDO_OCUPADO` (503), explícito.
- Conversão MUC: o MUC não detecta ambiguidade; a mitigação do adaptador (2B) foi validada por testes. Limitação documentada de precisão (seção 8).
- Autorização do operador: **não resolvida por desenho** — pertence à camada de rota; contrato mínimo na seção 9.
- Nenhuma integração com venda/Pedido/faturamento/pagamento; schema não ligado ao boot; MUC não alterado.

## 2. Arquivos
Modificados (todos criados na Sprint 2B, ainda sem commit):
- `backend/services/vendas/SaldoFiscalCategoriaService.js` — `executarEmTransacao` (erros estruturados), `conferirIdempotencia` (campos de conversão), cabeçalho documentando o contrato.

Criados:
- `tests/vendas/saldo-fiscal-categoria-concorrencia.test.js`
- `tests/vendas/saldo-fiscal-conversao-muc.test.js`
- `docs/vendas/sprint-2c-auditoria-integridade-concorrencia-relatorio.md`

Não alterados: `saldoFiscalCategoriaSchema.js`, MUC, `database.js`, qualquer serviço de venda/estoque, e os testes da 2B (preservados).

## 3. Frente A — Concorrência
Configuração real da aplicação (`backend/database.js`): conexão única `new sqlite3.Database`, `journal_mode=WAL`, `busy_timeout=30000`. O teste reproduz WAL + `foreign_keys=ON` + `busy_timeout=30000` em 4 conexões ao mesmo arquivo em `os.tmpdir()` (removido ao final). Nenhuma configuração global foi alterada.

| # | Cenário | Resultado observado |
|---|---|---|
| 1 | 2 entradas simultâneas (300 e 500) | ambas aplicadas; 1000 → 1800 |
| 2 | 2 saídas de 1000 sobre 1800 | 1 aplicada, 1 `SALDO_INSUFICIENTE`; saldo 800 |
| 3 | 2 aberturas simultâneas | 1 aplicada, 1 `ABERTURA_JA_REGISTRADA`; 1 movimento |
| 4 | 2 estornos do mesmo movimento (chaves diferentes) + 3º depois | 1 estorno; demais `ESTORNO_DUPLICADO` |
| 5 | Mesma chave e payload em 4 conexões | 1 criado, 3 `idempotente: true`, mesmo movimento |
| 6 | Mesma chave, payloads diferentes | 1 aplicada, 1 `IDEMPOTENCY_CONFLITO` |
| 7/8 | Empresas e categorias diferentes simultâneas | todas aplicadas, saldos independentes |
| Carga | 12 saídas de 100 sobre 500 em 4 conexões | exatamente 5 aplicadas; 7 `SALDO_INSUFICIENTE`; saldo 0 |

Após cada cenário, `verificarLedger` confere: saldo ≥ 0, soma(direção × quantidade) = saldo, encadeamento anterior/posterior contínuo e chaves únicas. Nos cenários 3 e 5 o vencedor varia entre execuções; os testes não dependem de quem vence. Executado 3 vezes consecutivas sem falha (a confiabilidade de longo prazo não foi medida).
Também testado: criação do schema por 4 conexões ao mesmo tempo.
Mecanismo: `BEGIN IMMEDIATE` serializa escritores no arquivo; o `UPDATE` condicional (`WHERE saldo_atual_ml = anterior`) é defesa adicional. **Não comprovado:** concorrência entre processos distintos (as conexões estão no mesmo processo Node, embora o driver as execute em threads separadas), outros sistemas de arquivos/rede, e `busy_timeout` esgotado com 30 s reais (testado apenas com `busy_timeout=0`).

## 4. Frente B — Idempotência e ledger
Identidade semântica da operação (comparada em `conferirIdempotencia`): tipo, categoria, quantidade, referência (tipo+id), motivo, usuário, origem sistêmica, movimento estornado, **e agora** `produto_id`, `quantidade_origem`, `unidade_origem` da conversão. Chave obrigatória (`IDEMPOTENCY_KEY_OBRIGATORIA`) e única por empresa (`UNIQUE(empresa_id, idempotency_key)`); mesma chave em outra empresa é outra operação (testado).
Testado: cada diferença (operador, origem sistêmica, motivo, tipo e id de referência, tipo de movimento, categoria, quantidade, conversão ausente/diferente) → `IDEMPOTENCY_CONFLITO`; repetição → `idempotente: true` com o movimento original. Atomicidade: verificação, UPDATE e INSERT estão na mesma transação; falha forçada (trigger temporário) no INSERT reverte o saldo, e a repetição posterior com a mesma chave é tratada como operação nova (nenhum estado parcial).
Observação: a falha no UPDATE do saldo sem movimento órfão é garantida pela mesma transação; não há teste separado que force falha no UPDATE.

## 5. Frente C — Estorno e proteção do ledger
Confirmado por teste, inclusive por SQL direto em outra conexão: `UPDATE` e `DELETE` em `saldo_fiscal_categoria_movimentos` abortam com `LEDGER_IMUTAVEL`. Estorno único por movimento (índice único parcial + checagem), mesmo empresa/categoria (trigger + checagem), saldo posterior = compensatório (CHECK), repetição idempotente retorna o registro original, segunda chave não estorna de novo (`ESTORNO_DUPLICADO`). Limitações inerentes: triggers valem para a tabela dentro do SQLite; quem tiver acesso ao arquivo pode fazer `DROP TRIGGER`/recriar a tabela (sem proteção contra DBA); `PRAGMA recursive_triggers`/`writable_schema` não foram avaliados. Não foi criada nenhuma exclusão administrativa.

## 6. Frente D — Contrato transacional final
Motivo real da restrição da 2B: a mesma conexão não aceita `BEGIN` aninhado e o serviço chama `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`.
Contrato adotado (menor correção segura; sem transações aninhadas/savepoints):
1. O serviço é **dono** da transação de cada mutação.
2. Se a conexão já está em transação, o `BEGIN IMMEDIATE` falha ("cannot start a transaction within a transaction") e é convertido em `TRANSACAO_EXTERNA_ATIVA` (409). Como o BEGIN falhou, nenhum `ROLLBACK`/`COMMIT` é emitido: a transação do chamador permanece intacta (testado: seu UPDATE continua visível e ele ainda faz `COMMIT`). Nenhuma escrita do serviço ocorre antes disso (as validações e o schema antes do BEGIN são só leitura/DDL idempotente — a DDL de schema `IF NOT EXISTS` pode executar dentro da transação do chamador na primeira chamada; ver limitações).
3. `SQLITE_BUSY` no BEGIN → `SALDO_OCUPADO` (503); conexão segue utilizável (testado com `busy_timeout=0`).
4. Erro no meio do trabalho → `ROLLBACK`; conexão fica fora de transação (testado reabrindo `BEGIN IMMEDIATE`).
5. As chamadas na mesma conexão são serializadas (fila por `WeakMap`).
Limitação: o sqlite3 do Node não expõe `inTransaction`, então a detecção depende da mensagem do SQLite. Risco residual na conexão compartilhada: SQL de **outras** partes da aplicação executado na mesma conexão enquanto a transação do serviço está aberta entra nessa transação e sofre seu COMMIT/ROLLBACK (limitação geral do modelo de conexão única; o serviço ainda não é chamado por nenhum fluxo). Esse ponto deve ser reavaliado na integração com vendas.

## 7. Frente E — Conversão pelo MUC
Comportamento verificado (`tests/vendas/saldo-fiscal-conversao-muc.test.js`, `:memory:`, somente leitura – tabelas `produtos`/`muc_produto_relacoes` inalteradas):
| Cenário | Resultado |
|---|---|
| Relação única UN→ML 1000 (2 UN) | 2000 ml |
| UN→ML sem relação | `CONVERSAO_INVALIDA` |
| FARDO sem apresentação / conteúdo 0 | `CONVERSAO_NAO_DISPONIVEL` |
| Relação incompatível (UN→KG) | `CONVERSAO_NAO_DISPONIVEL` |
| Ciclo | `CONVERSAO_CICLO` |
| Dois caminhos com mesmo resultado (UN→ML 1000; UN→L 1) | aceito, 1000 ml |
| Dois caminhos com resultados diferentes | `CONVERSAO_AMBIGUA` |
| 333,5 ml | `CONVERSAO_FRACIONARIA` (sem arredondar) |
| L→ML (relação SI; produto com conversão) | 2 L → 2000 ml |
| L→ML em produto sem conversão habilitada | `CONVERSAO_NAO_DISPONIVEL` (decisão conservadora da 2B) |
| Quantidade 0, negativa, NaN, Infinity, texto, null, undefined, booleano | `QUANTIDADE_INVALIDA`; unidade vazia `UNIDADE_INVALIDA`; produto 0 `PRODUTO_INVALIDO`; inexistente `PRODUTO_INEXISTENTE`; unidade `XYZ` `CONVERSAO_INVALIDA` |
Relação duplicada na mesma direção com fatores diferentes é impossível no schema (`UNIQUE(produto_id, origem, destino)`, verificado), o que cobre o ponto cego de `adicionarAresta` do MUC.
**Limitação de precisão comprovada:** o MUC arredonda a 9 casas antes de entregar o resultado; assim `1.0000000000004 UN × 1000` retorna `1000` e é aceito (frações < 1e-9 ml são invisíveis ao adaptador). Frações ≥ 1e-9 (ex.: `1.000001 UN` → 1000.001) são rejeitadas. Impacto prático nulo para ml, mas o contrato é "inteiro após arredondamento de 9 casas". Não alterei o MUC; extensão mínima possível: expor o valor sem arredondamento — **não implementada**, pendente de aprovação.
A conversão não abre movimento, não altera saldo e não reserva.

## 8. Frente F — Autorização do operador
Mecanismos existentes (inspeção direcionada de `backend/middleware/auth.js`): `verificarToken` (JWT → `req.user`), `exigirAdmin`, `verificarPermissaoEspecifica(nome)` com a tabela `usuario_permissoes`. São middlewares de **rota Express**; o serviço não tem contexto de requisição, e não existe permissão cadastrada para saldo fiscal. Criar permissão/rota/papel está fora do escopo. Decisão: o serviço **não** valida autorização e documenta isso no cabeçalho; `usuarioId` só *identifica* quem a camada superior autorizou; `origemSistemica` identifica processo interno, não é comprovada pelo serviço.
Contrato mínimo para a futura camada de aplicação: (1) autenticar (`verificarToken`); (2) autorizar com permissão explícita dedicada (ex.: via `verificarPermissaoEspecifica`, nome a definir/aprovar) antes de abrir, ajustar ou estornar; (3) derivar `usuarioId` do token, nunca do body; (4) restringir `empresaId` à empresa do usuário; (5) `confirmado: true` só após confirmação explícita do operador; (6) `origemSistemica` somente de código interno, nunca de entrada externa; (7) não expor `executarEmTransacao` nem chamar com transação aberta.
Pendência: `usuario_id` segue sem FK (a validação de existência do usuário não foi implementada, pois exigiria assumir o schema de usuários).

## 9. Testes executados (todos em bancos isolados; resultados observados)
| Comando | Resultado |
|---|---|
| `node --check backend\services\vendas\SaldoFiscalCategoriaService.js` | OK |
| `node tests\vendas\saldo-fiscal-categoria-concorrencia.test.js` (3 execuções) | passou nas 3 |
| `node tests\vendas\saldo-fiscal-conversao-muc.test.js` | passou |
| `node tests\vendas\saldo-fiscal-categoria.test.js` (2B) | passou |
| `node tests\vendas\categoria-fiscal-empresa.test.js` (Sprint 1) | passou |
| `node tests\muc\muc-public-contract.test.js` | 20 OK, 0 falhas |
| `node tests\muc\muc-03-configuracao-produto.test.js` | passou (saída sem falhas) |
Falhas intermediárias durante o desenvolvimento foram erros de expectativa dos meus testes novos (saldos esperados fixos em cenários cujo vencedor da corrida varia; códigos de erro reais do MUC), corrigidos nos testes; nenhuma validação foi enfraquecida.
Não executados: suíte completa, demais testes MUC, concorrência multiprocesso, teste isolado de falha no UPDATE do saldo.

## 10. Limitações restantes
- Concorrência comprovada só no mesmo processo (conexões distintas).
- A DDL do schema roda antes do `BEGIN`; numa conexão com transação externa a primeira chamada pode executar `CREATE ... IF NOT EXISTS` dentro dela (o erro vem em seguida, sem escrita de dados). Garantir o schema fora de transação (migração/boot controlado) é recomendado.
- Detecção de transação externa baseada em mensagem do SQLite.
- Ambiguidade: só detectada quando há caminho alternativo completo; precisão de 9 casas do MUC.
- Autorização e FK de `usuario_id` ficam para a camada de aplicação.
- Reservas, estoque mínimo/alertas e integração com vendas continuam não implementados.

## 11. Confirmações
- Saldos operacionais (`produtos`, `estoque_empresa`, pedidos, vendas) inalterados: os testes comparam snapshots (2B e `produtos` na concorrência); nenhum código toca essas tabelas.
- Banco oficial (`C:\ProgramData\MercantilFiscal\dados`) não acessado; apenas `:memory:` e um arquivo temporário apagado ao final. Nenhuma operação na SEFAZ. Nenhum commit, push, merge, reset ou limpeza. Alterações preexistentes do workspace preservadas.

## 12. Recomendação para a próxima sprint
Sprint 2D: reservas por pedido (tabela própria e idempotência por pedido/item) usando `saldo_reservado_ml`, ainda sem consumo/integração com venda; definir antes (a) o nome da permissão e a camada de rota, (b) a política de transação na integração com `VendaPagamentoService` (a transação do serviço é dona; integrar exigirá uma variante que participe da transação da venda) e (c) se a extensão do MUC para precisão sem arredondamento é necessária. Aprovação do PO pendente.
