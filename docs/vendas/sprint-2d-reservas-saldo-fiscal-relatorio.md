# Sprint 2D — Reservas do saldo fiscal compartilhado por Pedido

## 1. Resumo executivo
- Implementado serviço **interno** de reservas em ml por `(empresa_id, categoria_fiscal, pedido_id)`: `reservar`, `ajustarReserva`, `liberarReserva`, `obterReserva`, `listarReservasAtivas`, `listarEventos`.
- Uma reserva só incrementa `saldo_reservado_ml`; `saldo_atual_ml`, estoque físico, itens e valores do Pedido não são tocados.
- Atomicidade (saldo + reserva + evento), idempotência por chave e isolamento por empresa/categoria comprovados por testes, inclusive com 4 conexões SQLite independentes.
- Sem rotas, sem integração com Pedido/venda/faturamento/pagamento, sem boot, sem migração. O serviço **nunca executa DDL**.
- Autorização **não** é verificada pelo serviço (limitação documentada, seção 8).

## 2. Arquivos
Criados:
- `backend/services/vendas/reservaSaldoFiscalCategoriaSchema.js`
- `backend/services/vendas/ReservaSaldoFiscalCategoriaService.js`
- `tests/vendas/reserva-saldo-fiscal-categoria.test.js`
- `docs/vendas/sprint-2d-reservas-saldo-fiscal-relatorio.md`

Modificado (arquivo da Sprint 2B, ainda não commitado): `backend/services/vendas/SaldoFiscalCategoriaService.js` — apenas passou a exportar o objeto `internos` (`executarEmTransacao`, validadores, `lerSaldoRow`, `mapearSaldo`, etc.) para que as reservas reutilizem **a mesma fila/estratégia de lock** (sem criar segunda estratégia). Nenhum comportamento da 2B mudou.
`saldoFiscalCategoriaSchema.js` e o ledger da 2B **não** foram alterados.

## 3. Modelo de dados e invariantes
Decisão sobre o ledger: o ledger 2B registra variação de `saldo_atual_ml` (CHECK `posterior = anterior ± quantidade`, `quantidade > 0`). Reserva não altera `saldo_atual_ml`; usá-lo exigiria ampliar tipos e quebraria seu invariante soma(ledger) = saldo. Por isso foi criado um histórico próprio de reservas, sem fatos duplicados entre os dois (cada fato existe em um só lugar).

`saldo_fiscal_categoria_reservas` (estado): empresa (FK), categoria (CHECK), `pedido_id`, `quantidade_reservada_ml` (inteiro; >0 se ATIVA, 0 se LIBERADA), `status` (`ATIVA`|`LIBERADA`; sem `CONSUMIDA`), `idempotency_key` (chave de criação), timestamps, `liberada_em`, `motivo_liberacao`. FK composta `(empresa_id, categoria_fiscal)` → saldo 2B (impede reserva sem saldo/empresa ou em categoria sem saldo). Índice único parcial: **uma reserva ATIVA por (empresa, categoria, pedido)**. Triggers: DELETE proibido; empresa/categoria/pedido/chave/created_at imutáveis; reserva LIBERADA não pode ser alterada (nem reativada).
`saldo_fiscal_categoria_reserva_eventos` (append-only): `RESERVA` | `AJUSTE_RESERVA` | `LIBERACAO_RESERVA`; quantidade anterior/posterior, `delta_ml`, `saldo_atual_ml`, reservado anterior/posterior, origem, operador (`usuario_id` XOR/OR `origem_sistemica`), referência, `idempotency_key`, motivo, `created_at`; `UNIQUE(empresa_id, idempotency_key)`; CHECKs (`delta = posterior − anterior`, `reservado_posterior = anterior + delta`, `reservado_posterior ≤ saldo_atual`, coerência tipo × quantidades). UPDATE/DELETE bloqueados por trigger.
Escopo da chave: única por empresa em todas as operações de reserva (reservar/ajustar/liberar); namespace separado do ledger 2B.
Invariantes verificados pelo teste após cada cenário: `0 ≤ reservado ≤ atual`; soma das reservas ativas = `saldo_reservado_ml`; soma dos deltas dos eventos = reservado, com encadeamento contínuo; no máximo uma reserva ativa por pedido. O serviço também **recusa operar** (`RESERVA_INCONSISTENTE`) se `saldo_reservado_ml ≠ soma das reservas ativas` (ex.: reservado definido manualmente fora do serviço).
Sem FK para `pedidos`: `pedidos.empresa_id` é anulável no schema real (`database.js`) e o schema de teste pode diferir; a validação é feita pelo serviço (seção 7).
Plano de implantação futuro: executar `garantirSchemaReservaSaldoFiscalCategoriaAsync(db)` (após o schema 2B) fora de transação, em migração controlada. Nada foi aplicado ao banco oficial.

## 4. API real
Todas recebem `(params, { db })`; erros com `code` e `statusCode`. Parâmetros: `empresaId`, `categoriaFiscal`, `pedidoId`, `quantidadeMl` (inteiro positivo, tipo number), `idempotencyKey`, `usuarioId` XOR `origemSistemica`, `motivo`, `referencia {tipo,id}`.
- `reservar` — cria a reserva ativa; não abre saldo (`SALDO_NAO_ENCONTRADO`); com reserva ativa existente → `RESERVA_ATIVA_EXISTENTE` (não soma); sem disponibilidade → `SALDO_INSUFICIENTE`. Após liberação, uma **nova** chamada com **nova** chave cria uma **nova** linha de reserva (não há reativação; a chave antiga só retorna o resultado original).
- `ajustarReserva` — define a nova quantidade total de reserva ativa; delta positivo precisa caber no disponível; delta negativo libera só a diferença; mesma quantidade → `RESERVA_SEM_ALTERACAO`; inexistente → `RESERVA_NAO_ENCONTRADA` (nunca cria); liberada → `RESERVA_JA_LIBERADA`.
- `liberarReserva` — zera a reserva e reduz `saldo_reservado_ml`; `saldo_atual_ml` inalterado; reserva já liberada → `RESERVA_JA_LIBERADA`; **não** exige status ativo do Pedido (para permitir liberar após cancelamento), mas exige Pedido existente/empresa correta.
- `obterReserva` (reserva ativa ou a mais recente; `reservaId` opcional, sempre filtrando empresa/categoria/pedido), `listarReservasAtivas` (empresa e categoria obrigatórias; `limite` padrão 50, máx. 200, `offset`), `listarEventos` (auditoria).
Retorno das mutações: `{ idempotente, reserva, evento, saldo }`.

## 5. Idempotência
Identidade comparada: tipo, categoria, pedido, quantidade resultante, referência (tipo+id), motivo, usuário, origem sistêmica. Mesma chave + mesma identidade → `idempotente: true` com a reserva/evento originais (a verificação ocorre **antes** das regras de estado, então a repetição funciona mesmo após o Pedido ser cancelado ou a reserva liberada). Qualquer diferença → `IDEMPOTENCY_CONFLITO`. Chave nova com mesmo efeito não duplica: criação (`RESERVA_ATIVA_EXISTENTE`), ajuste (`RESERVA_SEM_ALTERACAO`), liberação (`RESERVA_JA_LIBERADA`).

## 6. Transações e concorrência
Reutiliza `executarEmTransacao` da 2B/2C: `BEGIN IMMEDIATE`, fila por conexão, `TRANSACAO_EXTERNA_ATIVA` (409, sem COMMIT/ROLLBACK da transação do chamador), `SALDO_OCUPADO` (503). Dentro da transação: idempotência → Pedido → saldo → consistência → regras → `UPDATE` condicional do saldo (guarda em atual e reservado, `changes` verificado) → `INSERT/UPDATE` da reserva (guarda em status/quantidade, `changes` verificado) → `INSERT` do evento. Schema: apenas verificação **somente leitura** em `sqlite_master` antes da transação; ausente → `SCHEMA_RESERVA_AUSENTE` (500), sem criar nada (testado).

## 7. Validação de empresa, Pedido e categoria
Empresa deve existir; categoria normalizada pela Sprint 1 (`REFRIGERANTE`/`AGUA`). O Pedido (`pedidos.id/empresa_id/status`, schema real) deve existir (`PEDIDO_NAO_ENCONTRADO`), ter empresa (`PEDIDO_SEM_EMPRESA`, pois a coluna é anulável) igual à informada (`PEDIDO_EMPRESA_DIVERGENTE`) e, para reservar/ajustar, estar em `PEDIDO`, `ABERTO`, `EM_SEPARACAO` ou `AGUARDANDO_FATURAMENTO` (`PEDIDO_STATUS_INVALIDO` para `ORCAMENTO`, `FATURADO`, `CANCELADO`; enums de `services/pedido/enums.js`). Se a tabela/colunas não existirem → `PEDIDO_CONTEXTO_INDISPONIVEL`. Nenhum Pedido é criado ou alterado pelo serviço.

## 8. Autorização — limitação
O serviço não autentica nem autoriza. `usuarioId` apenas identifica quem a camada superior autorizou; `origemSistemica` não é comprovada. Antes de uso real a camada de aplicação deve: autenticar (`verificarToken`), exigir permissão dedicada (a definir/aprovar), derivar `usuarioId` do token, derivar/validar `empresaId` a partir do usuário **e** do Pedido, e nunca aceitar `origemSistemica` de entrada externa. `usuario_id` segue sem FK. Enquanto isso, as operações **não devem ser expostas** a usuários reais.

## 9. Testes executados (bancos isolados; resultados observados)
| Comando | Resultado |
|---|---|
| `node --check` nos 3 serviços/schemas e no teste novo | OK |
| `node tests\vendas\reserva-saldo-fiscal-categoria.test.js` (3 execuções) | passou nas 3 |
| `node tests\vendas\saldo-fiscal-categoria.test.js` (2B) | passou |
| `node tests\vendas\saldo-fiscal-categoria-concorrencia.test.js` (2C) | passou |
| `node tests\vendas\saldo-fiscal-conversao-muc.test.js` (2C) | passou |
| `node tests\vendas\categoria-fiscal-empresa.test.js` (Sprint 1) | passou |
| `node tests\muc\muc-public-contract.test.js` | 20 OK, 0 falhas |
O teste novo passou na primeira execução; não houve ajuste de expectativas.
Cobertura efetivamente exercitada: schema (criação idempotente, CHECKs de quantidade/categoria/status, FK empresa e saldo, UNIQUE de reserva ativa, DELETE e identidade bloqueados, serviço sem DDL); reserva (válida, saldo insuficiente, 0/negativa/fracionária/string/NaN/null, categoria inválida/ausente, empresa inexistente/ausente, saldo não inicializado sem abertura automática, chave repetida igual/diferente em 7 variações, segunda reserva ativa, isolamento empresa/categoria, Pedido inexistente/de outra empresa/sem empresa/status inválido); ajuste (aumento, redução, acima do disponível, igual, inválida, inexistente, liberada, outra empresa, idempotência); liberação (válida, saldo reservado cai, saldo atual intacto, repetição, nova chave rejeitada, empresa/categoria/pedido incompatíveis, Pedido cancelado, sem reativação); ajuste de saldo da 2B não pode ficar abaixo do reservado; histórico imutável por SQL direto; atomicidade por trigger de falha no INSERT do evento (reservar/ajustar/liberar, snapshot completo idêntico) e repetição posterior; transação externa; inconsistência bloqueando operação; não regressão (produtos, estoque_empresa, vendas, ledger 2B e `saldo_atual_ml` inalterados).
Concorrência (4 conexões, arquivo temporário, WAL, `busy_timeout=30000`): reservas excedentes (1 aplicada, 1 `SALDO_INSUFICIENTE`); duas que cabem exatamente (ambas); criação inicial do mesmo Pedido em 3 conexões (1 reserva); duas alterações da mesma reserva (ambas serializadas, saldo final coerente); duas liberações (1 evento de liberação); mesma chave em 4 conexões (1 criada, 3 idempotentes) e payload diferente (conflito); empresas/categorias distintas; carga de 12 reservas (aplicadas = disponível/100, demais `SALDO_INSUFICIENTE`). Invariantes conferidos após cada cenário.
**Não testado/limitações:** concorrência entre processos distintos (conexões no mesmo processo Node); `busy_timeout` real esgotado; `SQLITE_BUSY` específico das reservas (usa o mesmo mecanismo testado na 2C); banco com `pedidos` real/legado (testado com schema equivalente reduzido); suíte completa não executada.

## 10. Confirmações
- Estoque operacional (`produtos.saldo_fiscal/saldo_nao_fiscal/estoque_atual`, `estoque_empresa`) não alterado — verificado por snapshot nos testes; o código não referencia essas tabelas.
- Nenhuma integração com Pedido, venda, pagamento ou faturamento (a única leitura é `pedidos`: id, empresa_id, status); nenhum valor comercial ou financeiro alterado.
- Banco oficial (`C:\ProgramData\MercantilFiscal\dados`) não acessado; só `:memory:` e arquivo temporário apagado ao final; nenhuma operação na SEFAZ; sem commit, push, merge ou reset; alterações preexistentes preservadas.

## 11. Decisões pendentes e recomendação
1. Nome da permissão e camada de rota/middleware que autorizará reservas.
2. Quem dispara a liberação (cancelamento/expiração do Pedido) — fora desta sprint.
3. Status do Pedido elegíveis para reservar (adotados os 4 listados; confirmar com o PO).
4. Tratamento de Pedidos legados com `empresa_id` NULL (hoje rejeitados).
5. Onde garantir o schema de reservas em produção (migração controlada).
6. Antes do consumo (próxima sprint): estado `CONSUMIDA`/movimento de saída fiscal, que exigirá recriar o CHECK de `status`/`tipo`, e a política de transação ao participar da transação da venda.
Recomendação: Sprint 2E — consumo fiscal de uma reserva (saída do `saldo_atual_ml` e baixa do reservado de forma atômica e idempotente, com ledger 2B), ainda sem integração automática com a venda; depois a integração com a criação da venda. Avaliação do Tech Lead pendente.
