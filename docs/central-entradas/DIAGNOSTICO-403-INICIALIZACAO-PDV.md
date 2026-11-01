# Diagnóstico — HTTP 403 na inicialização do PDV Express

Os três GETs da abertura do PDV Express passam pelo mesmo portão, antes da rota e antes de qualquer leitura de empresa ou terminal. Sem `Authorization`, os três respondem 401. Com um Bearer que o JWT não verifica, os três respondem o mesmo 403.

Data: 31/10/2026. Somente leitura. Nenhuma correção foi aplicada.

## 1. O que a sessão mostra

O processo `npm start` (Electron, porta 3001) estava ativo. O trecho de log a partir de 22:46:20 UTC contém carga fiscal, manifestação e MIRX. Não há linha de acesso HTTP, nem 403, nem usuário, nem `X-Empresa-Id`. O servidor não registra essas recusas.

A janela do PDV e o banco oficial não foram lidos. O usuário autenticado, o perfil e a empresa selecionada em `localStorage` não ficaram comprovados. O token não foi aberto.

O que o código da sessão colocaria no JWT, se o login tivesse sido aceito, é `id`, `usuario_id`, `username`, `nome`, `role`, `perfil`, permissões e, quando existirem, `terminal_id` e `caixa_sessao_id`. A validade é de 8 horas. Isso está em `finalizarLoginComUsuario`, em `backend/rotas/auth.js`. Sem um JWT válido, `req.user` não é preenchido.

`terminal_id=3` é query enviada pelo PDV (`getTerminalRequestQuery` / `obterTerminalIdPdv`). O hostname DESKTOP-4B8AMM3 é resolvido na estação (`estacaoHostname.js`) e não entra nesses três GETs. O handler de caixa só lê o terminal depois de autenticação, licença e empresa. O 403 do portão acontece antes disso.

## 2. Cabeçalhos que o PDV envia

Produtos e caixa usam `$.ajax`. O `ajaxSetup` de `frontend/shared/js/core.js` acrescenta:

- `Authorization: Bearer …` somente se `localStorage.token` existir;
- `X-Empresa-Id` somente se `CdsEmpresaContexto.lerEmpresaId()` for um inteiro positivo (`anexarHeaderXhr`).

`GET /api/vendas/pdv-modelo-empresa` usa `fetch` em `alinharContextoPdvModeloEmpresa` (`frontend/pdv/js/pdv.js`), com a mesma regra: Bearer se houver token, `X-Empresa-Id` via `headersJson` se houver empresa.

Não há outro cabeçalho exigido por essas três rotas. `terminal_id` vai na query, só no caixa.

Sonda em `http://127.0.0.1:3001` às 22:51 UTC, sem credencial real:

| Pedido | Produtos | Caixa | Modelo da empresa |
| --- | --- | --- | --- |
| Sem `Authorization` | 401 `{"error":"Acesso negado","code":"SESSAO_INVALIDA"}` | igual | igual |
| `Authorization: Bearer` que não verifica | 403 `{"error":"Token inválido ou expirado","code":"SESSAO_INVALIDA"}` | igual | igual |

Os três corpos e o `Content-Length` (50 no 401, 64 no 403) são idênticos. A resposta sai de `verificarToken` e a rota não corre.

## 3. Os três endpoints

Portão comum, em `backend/server.js`: `app.use('/api', apiAuthLicencaGate)`.

Ordem em `backend/middleware/apiAuthLicencaGate.js`: `verificarToken`, depois `licencaMiddleware`, depois a rota. Cada rota ainda declara `verificarToken` de novo. Na sonda, a primeira verificação já encerra o pedido.

### GET /api/produtos?modo_fiscal=1&somente_vendaveis=1

- Montagem: `app.use('/api/produtos', verificarToken, produtosRoutes)`.
- Rota: `router.use(criarMiddlewareContextoEmpresa(db))` e `GET /` em `backend/rotas/produtos.js`.
- 403 comprovado na sonda: `jwt.verify` falha em `backend/middleware/auth.js`. Condição: há Bearer e o token é inválido ou expirou. Não consulta produto, empresa nem terminal.
- 403 posterior, só com JWT válido: `EMPRESA_NAO_AUTORIZADA` se `X-Empresa-Id` vier e `exigirEmpresaAutorizada` recusar o usuário. Isso já leu empresa e `usuario_empresas`. Sem o header, o middleware segue com `empresaId` nulo e não responde 403.
- Licença vencida fora da tolerância não bloqueia este GET (`isAllowedDuringExpired` libera GET de produtos). Licença ausente (`motivo` diferente de `VENCIDA`) responde 403 `LICENCA_AUSENTE` depois da leitura da licença.

### GET /api/caixa/aberto?terminal_id=3

- Montagem: `app.use('/api/caixa', verificarToken, caixaRoutes)`.
- Rota: `GET /aberto` com `middlewareResolverEmpresaCaixa` em `backend/rotas/caixa.js`.
- 403 comprovado na sonda: o mesmo `SESSAO_INVALIDA`, antes de `anexarEmpresaCaixa` e antes de ler o terminal 3.
- 403 posterior, só com JWT válido: `EMPRESA_NAO_AUTORIZADA` no resolvedor do caixa, ou `CAIXA_SESSAO_EMPRESA_DIVERGENTE` se já existir sessão aberta de outra empresa. Este último é exclusivo do caixa e não explica os outros dois 403.
- Sem empresa, em modo multiempresa, a resposta prevista é 400 `CAIXA_EMPRESA_OBRIGATORIA`, não 403.
- Licença vencida fora da tolerância bloqueia caixa (o prefixo não está em `isAllowedDuringExpired`). Dentro da tolerância do PDV, `/api/caixa` segue.

### GET /api/vendas/pdv-modelo-empresa

- Montagem: `app.use('/api/vendas', verificarToken, vendasRoutes)`.
- Rota: `GET /pdv-modelo-empresa` em `backend/rotas/vendas.js`. O handler só devolve o modelo público. Não escolhe empresa nem terminal.
- O `router.use(criarMiddlewareContextoEmpresa(db))` roda antes, com a mesma regra de produtos.
- 403 comprovado na sonda: o mesmo `SESSAO_INVALIDA`, antes do handler.
- A Sprint 23 acrescentou `POST /composicao-sequencial` depois desse GET. Esse POST não participa da abertura e não muda o status deste GET.

## 4. Causa-raiz

Os três 403 observados na abertura têm o mesmo portão. A sonda no servidor que está na porta 3001 mostrou o mesmo corpo nos três quando o Bearer não verifica. Isso ocorre antes do banco da rota, da empresa e do terminal.

A sessão do operador não teve o corpo lido no Electron, então o `code` do 403 dele não foi copiado do navegador. O log do processo também não o gravou.

Hipótese alinhada ao sintoma, ainda não confirmada no navegador: o PDV envia `Authorization` e o JWT não passa em `jwt.verify` (expirado nas 8 horas, ou emitido com outro segredo). Ausência do header seria 401, não 403.

Hipóteses que só valem depois de um JWT válido, e que a sonda não reproduziu:

- Licença ausente ou data alterada: 403 `LICENCA_AUSENTE` ou `DATA_ALTERADA` nos três, depois da leitura da licença.
- `X-Empresa-Id` de uma empresa sem vínculo ativo: 403 `EMPRESA_NAO_AUTORIZADA` nos três, depois do banco. O middleware passa só o id numérico a `exigirEmpresaAutorizada`. `administradorOperacional` não vê `role` nem `perfil` do JWT nesse caminho. Um administrador sem linha em `usuario_empresas` cai na mesma recusa de um operador sem vínculo.
- Divergência de terminal ou de sessão de caixa não é a causa comum. Ela só existe no caixa, e só depois da empresa autorizada.

## 5. Sprint 23

A Sprint 23 não alterou `apiAuthLicencaGate`, `verificarToken`, a licença, `empresaContexto`, o resolvedor de caixa nem o contrato desses três GETs. O script `pagamentoSequencial.js` e o POST de composição não rodam na carga inicial. Os três pedidos continuam saindo de `loadPDV`, `verificarStatusCaixa` e `alinharContextoPdvModeloEmpresa`.

## 6. Correção mínima recomendada

Não desligar o portão e não relaxar empresa.

1. No navegador, ler o JSON dos três 403, sem copiar o token. Se os três forem `code: SESSAO_INVALIDA` e a mensagem for token inválido ou expirado, a correção é um novo login. Não há mudança de middleware.
2. Se o `code` for `LICENCA_AUSENTE` ou `DATA_ALTERADA`, o tratamento é a licença, não o PDV.
3. Se o `code` for `EMPRESA_NAO_AUTORIZADA`, conferir o `empresa_id` do JSON com o vínculo do usuário. A correção mínima, se o usuário for administrador operacional sem linha em `usuario_empresas`, é passar `req.user` a `exigirEmpresaAutorizada` para a regra já existente de administrador valer também nesses GETs. Isso fica para avaliação do Tech Lead.

Nenhuma dessas correções foi implementada.
