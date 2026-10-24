# Sprint 2.3.2 — Diagnóstico definitivo da RC4.1.2

## Conclusão

**Diagnóstico concluído e corrigido. RC4.1.2 aprovada na execução integral.**

A causa não era um import isolado nem o bootstrap do banco. O teste declarava duas funções de topo com o mesmo nome `run`: o helper de SQL e a função que orquestrava todos os cenários. A declaração posterior `async function run()` substituía o binding do helper. Assim, cada chamada pretendida a `db.run(sql, ...)` iniciava outra execução completa dos cenários em vez de executar SQL.

O ciclo observado era:

```text
runScenarios
  → cenário 1
    → setupDb
      → helper run(db, SQL) resolve para a função principal da suíte
        → nova runScenarios
          → novo cenário 1
            → novo setupDb e nova conexão SQLite :memory:
              → ...
```

Como a recursão acontecia durante a criação do banco, nenhum cenário alcançava seu fechamento SQLite. O processo acumulava conexões nativas; por isso aumentar o heap JavaScript para 1 GiB não resolvia a causa. O valor alto de RSS, com heap relativamente baixo, confirma que o consumo incluía alocações nativas das conexões e não era evidência de um vazamento provocado pelo carregamento dos módulos.

## Evidências do diagnóstico

Instrumentação temporária adicionada ao teste mediu tempo, RSS, heap usado/total, memória externa, `arrayBuffers`, etapa e quantidade de conexões SQLite abertas. A execução foi limitada a 15 segundos, com o banco de bootstrap em `DB_DIR` temporário e os cenários em `:memory:`.

| Marco observado | Evidência |
|---|---|
| Início do processo | RSS 39 MiB; heap usado 6 MiB; zero banco SQLite de cenário aberto. |
| Imports até `pedidoReservaPonteNucleo` | ~0,4 s; heap usado ~8 MiB. |
| `FaturamentoService` importado e bootstrap isolado concluído | ~5,9 s; RSS 61 MiB; heap usado 20 MiB; zero conexão SQLite dos cenários. |
| Entrada no primeiro cenário | payload `pedido_id` concluiu; cenário 1 iniciou. |
| Execução recursiva | em 15,5 s: 73.202 conexões SQLite abertas, RSS ~3.126 MiB, heap usado ~138 MiB de ~257 MiB. Novas mensagens `runScenarios` e `scenario 1` apareceram sem que um cenário terminasse. |
| Interrupção diagnóstica | limite temporário interrompeu a execução com código 124; essa execução instrumentada não foi considerada validação funcional. |

Essa ordem demonstra que imports e bootstrap completaram com uso baixo de memória antes do ciclo recursivo. A contagem de conexões crescendo junto com as reentradas, sem eventos de fechamento, identifica o acúmulo de conexões SQLite decorrente da colisão de nomes.

## Correção

Em `tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js`:

1. Renomeado o orquestrador da suíte para `runScenarios`, preservando o helper SQL `run(db, sql, params)`.
2. Restaurada a importação pública original `backend/motores/comercial`, sem mocks nem remoção de verificações.
3. Mantidos o `FaturamentoService` real, o bootstrap aditivo do banco sob `DB_DIR` temporário e todos os cenários de reserva em SQLite `:memory:`.
4. Adicionada saída explícita `OK` para o payload e para cada um dos cinco cenários.
5. A função de encerramento do banco de teste agora rejeita erros de `db.close` em vez de ignorá-los.
6. A instrumentação detalhada foi removida após o diagnóstico; não há dependência de heap ampliado para a execução final.

Nenhuma regra de produção, fiscal, XML, TEF, estoque ou cálculo financeiro foi alterada nesta Sprint.

## Validação final da RC4.1.2

Com `DB_DIR` temporário e sem `--max-old-space-size`, o comando:

```text
node tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js
```

terminou com exit code `0`, imprimindo:

- `OK payload pedido_id`
- `OK cenário 1 — pedido igual ao saldo autorizado`
- `OK cenário 2 — dois pedidos e expedição do pedido A`
- `OK cenário 3 — pedido B bloqueado`
- `OK cenário 4 — cancelamento libera reserva`
- `OK cenário 5 — legado sem reserva`
- `RC4.1.2 OK — 5 cenários + pedido_id no payload`

O bootstrap imprimiu os caminhos do banco temporário e avisos de migração por colunas TEF duplicadas já observados em execuções isoladas anteriores; não impediu o sucesso e não envolveu o banco oficial. O diretório temporário foi removido ao final.

## Regressões da Sprint 2.3.1 reexecutadas

| Teste | Resultado |
|---|---|
| `tests/financeiro/sprint-2-3-1-recebimentos-integrados.test.js` | Aprovado — componentes, pagamento parcial, repetição, conflito por saldo obsoleto e rollback. O log de conflito `409` foi provocado intencionalmente pelo caso de teste. |
| `tests/vendas/parcelas-receber-componentes.test.js` | Aprovado — soma de componentes e distribuição de centavos. |
| `tests/faturamento/calculo-financeiro-pedido.test.js` | Aprovado — quatro cenários de total. |
| `tests/orquestrador-pagamento.test.js` | Aprovado em banco temporário — inclui cobertura TEF/Outros e recebimentos segregados. |
| `tests/faturamento/sprint31-faturamento.test.js` e `tests/faturamento/sprint314-orcamento-pedidos.test.js` | Aprovados em banco temporário — 15 testes, zero falhas. |
| RC4.1.2 corrigida | Aprovada — payload e cinco cenários, exit code zero. |

Uma tentativa de execução sem `DB_DIR` foi barrada por `sqliteOfficialGuard`; não abriu nem migrou o banco oficial e não foi contada como teste funcional.

## Arquivos alterados

- `tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js` — corrigida colisão de funções, resultados explícitos por cenário e erro de fechamento não silenciado.
- `SPRINT-2.3.1-VALIDACAO-INTEGRADA-FINANCEIRA.md` — atualizado para apontar a correção e aprovação da RC4.1.2 nesta Sprint.
- `SPRINT-2.3.2-DIAGNOSTICO-RC4.1.2.md` — este diagnóstico e evidências.

Nenhum commit, push, merge, reset ou operação destrutiva foi realizado.
