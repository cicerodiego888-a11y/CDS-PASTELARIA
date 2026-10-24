# Sprint B1-F1 — Diagnóstico isolado da regressão de disponibilidade

## Conclusão

**Classificação: incompatibilidade do teste com o contrato atual do Motor Comercial.**

O resultado `PEDIDO_NAO_ENCONTRADO` é produzido antes da consulta de disponibilidade e antes da avaliação de saldo. O teste usa `pedidoId: 36`, mas não insere o Pedido 36 na tabela `pedidos`. Para um ID positivo, o Motor valida a existência e o `empresa_id` do Pedido antes de confirmar reserva. Portanto, o resultado esperado `SALDO_INSUFICIENTE` não pode ser atingido com a preparação atual.

Não há evidência de regressão no Motor Comercial causada pelas alterações locais desta sprint B1. Não foi implementada correção nesta etapa.

## 1. Preparação e asserção do teste

Arquivo examinado: `tests/estoque/pedido-disponibilidade-multiempresa.test.js`.

O helper `setup()` cria SQLite `:memory:`, schema de empresas/estoque, um produto com saldo fiscal global 100 e dois saldos isolados por empresa:

- empresa A: saldo fiscal 10, reservado 2, disponibilidade fiscal 8;
- empresa B: saldo fiscal 3, reservado 0, disponibilidade fiscal 3.

O teste `test01PedidoBBloqueado()` chama `confirmarEstoqueViaMotorComercial` com `pedidoId: 36`, `empresaId` da empresa B e quantidade solicitada 5. A asserção espera `SALDO_INSUFICIENTE`. **Nenhum registro é inserido em `pedidos`** antes dessa chamada.

Os testes `test02PedidoAPermitido()` e `test03AnaliseMotorComercial()` também usam `pedidoId` positivo sem inserir esses Pedidos. A execução aborta no primeiro teste, logo esses cenários não foram executados nesta rodada.

## 2. Caminho que produz o erro

1. `confirmarEstoqueViaMotorComercial` em `PedidoOperacionalService.js` delega sem alteração a `MotorComercial.confirmarPedidoFiscal`.
2. `confirmarPedidoFiscal` chama `analisarDisponibilidadeFiscal` antes de iniciar a confirmação.
3. `analisarDisponibilidadeFiscal` chama `resolverEmpresaMotor`.
4. `resolverEmpresaMotor` converte o ID e, por ser inteiro positivo (`36`), consulta `pedidos` por esse ID via `carregarPedido`.
5. A consulta retorna vazio porque o teste não semeou esse pedido.
6. `resolverEmpresaMotor` lança `PEDIDO_NAO_ENCONTRADO`; a disponibilidade por empresa e a comparação da quantidade solicitada não são avaliadas.

O caminho relevante está em `backend/motores/comercial/MotorComercialService.js`: `carregarPedido`, `resolverEmpresaMotor`, `analisarDisponibilidadeFiscal` e `confirmarPedidoFiscal`. A função pública `confirmarEstoqueViaMotorComercial` apenas encaminha os dados e propaga o erro.

## 3. Evidências do contrato correto

- O comentário de `resolverEmpresaMotor` estabelece que um **Pedido existente** obtém ownership de `pedidos.empresa_id`; a alternativa sem Pedido usa o contexto explícito de empresa.
- Para qualquer `pedidoId` positivo, a implementação carrega o Pedido e retorna `PEDIDO_NAO_ENCONTRADO` se ele não existir. Se existir, também valida a empresa e rejeita divergência.
- A confirmação de reservas é uma operação sobre um Pedido identificado; a validação de saldo insuficiente ocorre depois de resolver esse ownership.
- O histórico local de `MotorComercialService.js` atribui a validação de existência/ownership ao commit `646efa8` (conforme `git blame` nas linhas de `carregarPedido` e `resolverEmpresaMotor`).
- `PedidoOperacionalService.js` e o teste de disponibilidade não têm alterações locais nesta análise. O arquivo de serviço aparece modificado no workspace por mudanças anteriores de validação monetária em `montarCabecalho`; o diff não toca em `confirmarEstoqueViaMotorComercial`.
- O Motor Comercial e o teste-alvo não têm diff local. Assim, a alteração B1 não introduziu o caminho que rejeita esse ID inexistente.

## 4. Teste executado

Executado uma vez, isoladamente:

```text
NODE_ENV=test
DB_DIR=<diretório temporário dedicado>
node tests\estoque\pedido-disponibilidade-multiempresa.test.js
```

Resultado: **falhou na primeira asserção** em `test01PedidoBBloqueado()`:

```text
esperado: SALDO_INSUFICIENTE
recebido: PEDIDO_NAO_ENCONTRADO
exit code: 1
```

O teste usa SQLite `:memory:` para o cenário. O módulo de banco importado indiretamente abriu seu banco de teste sob o `DB_DIR` temporário indicado; não foi usado banco operacional. Não foram executados testes complementares porque o fluxo e a ausência do Pedido na preparação identificam a causa sem ambiguidade.

## 5. Histórico e escopo local

- `git blame` confirma que a validação de existência/ownership para IDs positivos está no Motor desde `646efa8`.
- O helper de Pedido em `PedidoOperacionalService.js` delega ao Motor; sua alteração local atual é somente a validação de total operacional introduzida na Fase B1.
- Não foi alterado código de produção nem o teste nesta sprint.
- Nenhuma alteração local foi descartada, revertida ou sobrescrita.

## 6. Classificação

**Incompatibilidade do teste**, não regressão demonstrada.

O teste modela uma confirmação de Pedido com apenas um ID fictício. O contrato implementado requer o registro persistido para obter e validar a empresa proprietária. A asserção de `SALDO_INSUFICIENTE` está numa fase posterior do fluxo e não é apropriada para esse setup.

## 7. Próxima ação recomendada

Em uma etapa futura de manutenção do teste, preparar o cenário inserindo o Pedido 36 com `empresa_id` correspondente antes da confirmação. Então a primeira asserção poderá verificar o saldo da empresa B. Inserir também os Pedidos usados nos testes 02 e 03, com ownership alinhado aos seus respectivos contextos. Essa alteração deve ser feita como atualização do contrato do teste, não mudando `PEDIDO_NAO_ENCONTRADO` para `SALDO_INSUFICIENTE`.

## 8. Segurança e limitações

- Nenhum banco operacional foi aberto; o teste foi isolado em `:memory:`/`DB_DIR` temporário.
- Nenhuma operação SEFAZ foi executada.
- Nenhum ERP foi iniciado contra base real.
- Motor Comercial, núcleo de reservas e teste não foram alterados.
- Nenhum teste amplo foi executado; somente o teste-alvo, uma vez.
- Nenhum commit, push, merge, reset ou checkout destrutivo foi executado.
