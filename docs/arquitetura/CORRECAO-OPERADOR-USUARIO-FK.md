# Correção do operador na persistência da venda

**ID:** CDS-PDV-OPERADOR-USUARIO-FK-01  
**Erro:** `Operador 2 não existe. vendas.operador_id referencia usuarios(id).`  
**Banco oficial:** não foi consultado nem alterado.

## Causa raiz

`vendas.operador_id` referencia `usuarios(id)`. O PDV autentica pela tabela `usuarios`: o login grava `id` e `usuario_id` no token e o mesmo usuário no `localStorage`. O frontend não envia outro operador no corpo da venda.

A persistência não usava esse usuário. `validarCaixaAberto` fazia `req.operadorId = req.user.id || sessao.operador_id`. O número da sessão era aceito como se fosse `usuarios.id`.

No banco temporário, o cadastro `operadores.id = 2` existe e `usuarios` não tem a linha 2. O usuário autenticado `caixa` está em `usuarios.id = 5`. A sessão 8 guardava o operador 2. Os dois números não são o mesmo cadastro. A validação bloqueava a venda porque o 2 não está em `usuarios`.

## Correção

`resolverOperadorUsuario` resolve o operador assim:

1. Pelo `username` do token, na tabela `usuarios`.
2. Sem username, pelo `usuario_id` ou `id` do token, somente se a linha existir em `usuarios`.
3. Sem usuário autenticado, a gravação para com `SESSAO_SEM_USUARIO`.

`caixa_sessoes.operador_id` não entra mais nesse campo. Não é criado usuário, não há ID padrão e o SUPER ADMIN não substitui o operador. Se a empresa já tem vínculos em `usuario_empresas`, o usuário precisa do vínculo ativo, salvo administrador, que continua gravado com o próprio `usuarios.id`.

O valor devolvido é o que os dois `INSERT` de `vendas` gravam em `operador_id`.

## Arquivos

- `backend/services/vendas/VendaReferenciaIntegridade.js`
- `backend/middleware/validarCaixaAberto.js`
- `backend/services/vendas/VendaPagamentoService.js`
- `tests/vendas/operador-usuario-fk.test.js`

## Testes

`node --test --test-concurrency=1 tests/vendas/operador-usuario-fk.test.js tests/vendas/integridade-fk-persistencia-venda.test.js`

8 testes, 8 aprovações. O usuário `caixa` grava o operador 5. O id 2 do outro cadastro, o id 77 e a sessão sem usuário bloqueiam a venda. Usuário da empresa 1 não grava na empresa 2. Rollback remove a venda parcial e a repetição grava uma venda, com `operador_id = 5`.

## O que não mudou

Composição, valores comerciais e fiscais, regra do dinheiro, estoque, pagamentos, TEF, emissor e as FOREIGN KEYs permanecem como estavam.
