# Sprint B1-F2 — Ajuste do teste de disponibilidade multiempresa

## Alteração

Foi alterada exclusivamente a preparação em `tests/estoque/pedido-disponibilidade-multiempresa.test.js`.

- O schema SQLite isolado do teste agora inclui a tabela `pedidos` com os campos necessários ao contrato consultado (`id`, `codigo`, `data_pedido`, `total`, `status`, `empresa_id`), conforme a estrutura de `pedidos` declarada em `backend/database.js`.
- Foi adicionado o helper de fixture `seedPedido`, que insere o ID, código sintético, data, total e empresa do cenário.
- Cenário 01: Pedido 36 semeado com `empresa_id` da empresa B.
- Cenário 02: Pedido 36 semeado com `empresa_id` da empresa A.
- Cenário 03: Pedido 1 semeado para a empresa B e Pedido 2 para a empresa A.
- Os saldos e reservas existentes no setup não foram modificados.
- Asserções de negócio foram preservadas, incluindo `SALDO_INSUFICIENTE` no cenário sem saldo suficiente.

Nenhum arquivo de produção, regra de reserva ou Motor Comercial foi alterado.

## Teste executado

Foi executado somente o teste-alvo, uma vez, com `NODE_ENV=test` e `DB_DIR` em diretório temporário dedicado:

```text
node tests\estoque\pedido-disponibilidade-multiempresa.test.js
```

**Resultado: 4/4 cenários OK, exit code 0.**

- Pedido da empresa B com disponibilidade insuficiente é bloqueado.
- Pedido da empresa A com disponibilidade suficiente pode reservar.
- Análise do Motor Comercial respeita o saldo isolado por empresa.
- Consulta pública mantém o mesmo resultado de disponibilidade multiempresa e o contrato legado testado.

O teste usa SQLite `:memory:` para os dados do cenário. O bootstrap da aplicação abriu também seu banco de teste sob o `DB_DIR` temporário; nenhum banco operacional foi usado.

## Segurança e escopo

- Nenhum banco operacional foi acessado.
- Nenhuma operação SEFAZ foi executada.
- Nenhuma bateria de testes foi executada.
- Não foi feito reset, checkout destrutivo, commit, push ou merge.
- Alterações preexistentes do workspace foram preservadas.
