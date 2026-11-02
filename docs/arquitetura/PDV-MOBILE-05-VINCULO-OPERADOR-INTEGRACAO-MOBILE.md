# PDV-MOBILE-05 — Vínculo operador–cobrança e integração dos módulos mobile

## 1. Branch e commit

- Branch: `fix/p0-lentidao-cancelamento-nfce`
- Commit de referência: `0fab77d59ff5d283e23d4fdb0b624204a5293c34` (`implemetação Diversas`)
- As alterações locais anteriores foram preservadas. Nenhuma branch foi trocada e nenhum arquivo foi descartado.
- Classificação: CONCLUÍDO

## 2. Identidade e sessão encontradas

A sessão continua no JWT de `verificarToken`. O usuário autenticado chega em `req.user.id`. A empresa autorizada continua em `resolverEmpresaAutorizadaTef` e `exigirEmpresaAutorizada`, pelo cabeçalho `X-Empresa-Id` ou pelo caixa aberto. O parâmetro `empresa_id` da URL não escolhe a empresa.

Mobile Pedido e Mobile PDV são páginas da mesma origem. Os dois leem o token e o usuário em `localStorage` e a empresa em `CdsEmpresaContexto`. Não há login separado. Copiar `operador_id` para o armazenamento do navegador não autentica a cobrança: a leitura e o fechamento usam o usuário do token.

Antes desta sprint, `tef_transacoes` tinha `empresa_id` e `idempotency_key`, e não tinha o operador. Dois operadores da mesma empresa que conhecessem a chave liam a mesma cobrança.

Classificação: CONCLUÍDO

## 3. Vínculo da cobrança com o operador

A coluna `operador_id` entrou em `tef_transacoes` pelo `CREATE TABLE` das bases novas e pelo `ALTER TABLE` já usado nas migrações. Não foi criada outra tabela.

`POST /api/tef/pagar` grava `operador_id` com o id da sessão. O `operador_id` enviado no corpo é ignorado. Se a mesma chave já pertence a outro operador, a resposta é `TEF_OPERADOR_DIVERGENTE`, sem devolver a transação dele.

`GET /api/tef/acompanhamento` exige, juntos, sessão, empresa autorizada, `operador_id` igual ao da sessão, chave e estado persistido. Cobrança de outro operador da mesma empresa responde como não encontrada, sem NSU e sem `transacao_id`. A leitura não chama adaptador, não altera `atualizado_em` e não cria parcela.

Cobrança antiga com `operador_id` nulo não aparece no acompanhamento. O fechamento dessas linhas antigas permanece possível, para não interromper venda já iniciada antes da coluna. Cobrança nova sai sempre com o operador da sessão.

Classificação: CONCLUÍDO e TESTADO

## 4. Fechamento

`comprovarTransacoesTefAprovadas` confere de novo, antes de aceitar o pagamento:

- empresa da transação igual à da venda;
- operador da transação, quando preenchido, igual ao da sessão. O `operador_id` do corpo não substitui a sessão;
- chave de correlação, quando enviada, igual à chave persistida;
- estado aprovado, valor e tipo persistidos;
- ausência de `venda_id`.

O `UPDATE` que grava a venda exige `venda_id IS NULL`, a empresa da venda e `operador_id` nulo ou igual ao da sessão. A segunda execução altera zero linhas. A mesma cobrança não entra em outra venda, nem pelo mesmo operador.

Classificação: CONCLUÍDO e TESTADO

## 5. Dois operadores da mesma empresa

No banco temporário `cds-mobpdv05-*`, empresas A (`11222333000181`) e B (`04252011000110`):

- Operador A acompanha a própria cobrança aprovada e recebe `transacao_id`, valor e tipo. Sem NSU.
- Operador A2, vinculado à mesma empresa A, recebe `encontrado: false` para a chave de A.
- A2 não comprova essa chave no fechamento: “Transação TEF pertence a outro operador.”
- A não troca a chave de uma cobrança pela de outra no fechamento.
- `operador_id` de A2 no corpo de `POST /api/tef/pagar` não muda o operador gravado. O valor capturado é o id da sessão de A. O adaptador real não foi chamado.

Classificação: TESTADO

## 6. Duas empresas

- Operador A com cabeçalho da empresa B: 403 `EMPRESA_NAO_AUTORIZADA`, mesmo com `empresa_id` da B na URL.
- Operador da empresa B com cabeçalho da A: 403.
- Operador da B, na própria empresa, não encontra a chave da A e a resposta não contém NSU.
- Operador sem empresa autorizada: 403 `EMPRESA_NAO_AUTORIZADA`.

Classificação: TESTADO

## 7. Reutilização e idempotência

- A mesma comprovação, antes do vínculo, pode ser repetida.
- O primeiro `UPDATE` condicionado vincula a venda. O segundo, do mesmo operador ou de outro, altera zero linhas e a venda permanece a primeira.
- Depois do vínculo, a comprovação recusa a cobrança como já vinculada.
- Pendente, negado, timeout, falha de comunicação e cancelado não aprovam a leitura e não passam na comprovação.
- Sem token: 401 `SESSAO_INVALIDA`. Token expirado: 403 `SESSAO_INVALIDA`. Nenhum dos dois devolve a cobrança.

Classificação: TESTADO

## 8. Navegação entre os módulos

Pedido e PDV mostram a navegação “Módulos do CDS”, com links `/mobile-pedido/` e `/mobile-pdv/` na mesma origem. O encaminhamento oficial `preparar-venda-pdv` foi mantido. O snapshot passa a carregar `sessao_operador_id` do usuário já autenticado na página. O PDV recusa abrir o pedido se esse operador ou a empresa do contexto divergem. Isso não substitui a sessão do backend.

No servidor de teste `127.0.0.1:3097`, banco `cds-mobpdv05-ui`, com a licença legítima intacta:

- um login levou a `/mobile-pedido/`;
- o módulo PDV abriu sem outro login e mostrou “Operador: Administrador”;
- o retorno pelo link Pedido voltou a `/mobile-pedido/`;
- sem token, `/mobile-pdv/` redireciona para `/login?next=/mobile-pdv`.

A licença respondeu `LICENCA_AUSENTE` (“Sistema não ativado.”) ao listar empresas e ao consultar a cobrança. Seleção de empresa, gravação de pedido, snapshot comercial e acompanhamento da cobrança na tela ficaram BLOQUEADOS. A proteção de licença não foi removida. O servidor de teste foi encerrado. O endereço do celular no servidor em uso continua `http://192.168.0.11:3001/mobile-pedido/` e `http://192.168.0.11:3001/mobile-pdv/`.

Classificação da navegação entre as páginas e da sessão compartilhada: HOMOLOGADO. Classificação de empresa, pedido e cobrança na tela: BLOQUEADO pela licença ausente.

## 9. Sessão compartilhada

Os dois módulos usam o mesmo token, o mesmo usuário e o mesmo contexto de empresa. O nome do operador na tela sai do usuário da sessão, não de um campo livre. A cobrança só é lida e comprovada com o id desse token no backend.

Classificação: TESTADO no banco temporário e HOMOLOGADO na troca de páginas do servidor de teste.

## 10. Testes automatizados

`node --test --test-concurrency=1` nos arquivos desta sprint e nas regressões pedidas:

| Arquivo | Resultado |
| --- | --- |
| `tests/mobile-pdv/pdv-mobile-05.test.js` | 12 passaram |
| `tests/mobile-pdv/pdv-mobile-04.test.js` | 7 passaram |
| `tests/mobile-pdv/pdv-mobile-03.test.js` | 13 passaram |
| `tests/mobile-pdv/pdv-mobile-02.test.js` | 14 passaram |
| `tests/pdv/sprint-25-interacao-sequencial.test.js` | 4 passaram |
| `tests/vendas/sprint-2-7-recalculo-preco-quantidade.test.js` | 16 passaram |
| `tests/vendas/sprint-2-6-atualizar-quantidade-atacado.test.js` | 9 passaram |
| `tests/pdv-universal/preco-atacado-05-35.test.js` | 1 passou |
| `tests/vendas/pedido-pdv-composicao.test.js` | 19 passaram |

Não houve cobrança real, adaptador TEF na leitura, SEFAZ nem banco oficial.

Classificação: TESTADO

## 11. O que permanece fora

- Integração Smart POS Itaú: BLOQUEADO, fora desta sprint.
- Emissão fiscal mobile: BLOQUEADO. O botão permanece desabilitado.
- Homologação visual de preço, quantidade, dinheiro e estados da cobrança no celular: BLOQUEADO por `LICENCA_AUSENTE` no servidor sem licença.
- Cobrança antiga sem `operador_id` ainda pode ser vinculada no fechamento. Cobrança nova não entra nesse caso.
